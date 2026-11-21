/* PDF ↔ 이미지 — 모든 처리는 기기 안에서만 (서버 전송 없음) */
'use strict';
(function () {

  /* ------------------------------------------------------------------ *
   * 0. 기반 설정
   * ------------------------------------------------------------------ */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const baseURI = document.baseURI;

  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('vendor/pdf.worker.min.js', baseURI).href;
  }
  const STANDARD_FONTS = new URL('vendor/standard_fonts/', baseURI).href;

  const MAX_PREVIEW_PAGES = 60;      // 미리보기 렌더 상한 (변환은 전체 페이지)
  const MAX_CANVAS_PIXELS = 12e6;    // 1장당 캔버스 픽셀 상한 (iOS 안전선)

  /* ------------------------------------------------------------------ *
   * 1. 공통 유틸
   * ------------------------------------------------------------------ */

  let toastTimer = null;
  function toast(message, ms) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-on'), ms || 2600);
  }

  function formatBytes(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function stamp() {
    const d = new Date();
    return '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
      '-' + pad2(d.getHours()) + pad2(d.getMinutes());
  }

  function baseName(name) {
    return String(name || 'document').replace(/\.[^.]+$/, '').replace(/[/\\:*?"<>|]+/g, '_').slice(0, 60) || 'document';
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 6000);
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      if (canvas.toBlob) {
        canvas.toBlob(b => (b ? resolve(b) : reject(new Error('blob-failed'))), type, quality);
      } else {
        try {
          const dataUrl = canvas.toDataURL(type, quality);
          const bin = atob(dataUrl.split(',')[1]);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          resolve(new Blob([arr], { type }));
        } catch (e) { reject(e); }
      }
    });
  }

  function hex4(n) { return Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0'); }

  function canShareFiles() {
    return !!(navigator.canShare && navigator.share);
  }

  function setProgress(prefix, ratio, text) {
    const wrap = $('#' + prefix + 'Progress');
    const fill = $('#' + prefix + 'ProgressFill');
    const label = $('#' + prefix + 'ProgressText');
    wrap.classList.remove('hidden');
    fill.style.width = Math.round(Math.max(0, Math.min(1, ratio)) * 100) + '%';
    if (text) label.textContent = text;
  }
  function hideProgress(prefix) {
    $('#' + prefix + 'Progress').classList.add('hidden');
    $('#' + prefix + 'ProgressFill').style.width = '0%';
  }

  const nextFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));

  /* ------------------------------------------------------------------ *
   * 2. 탭 전환
   * ------------------------------------------------------------------ */

  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const name = tab.dataset.tab;
      $$('.tab').forEach(t => {
        const on = t === tab;
        t.classList.toggle('is-active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      $('#panel-pdf2img').classList.toggle('is-active', name === 'pdf2img');
      $('#panel-img2pdf').classList.toggle('is-active', name === 'img2pdf');
      window.scrollTo({ top: 0, behavior: 'auto' });
    });
  });

  function segmented(containerId, onChange) {
    const box = $('#' + containerId);
    if (!box) return;
    box.addEventListener('click', ev => {
      const btn = ev.target.closest('.seg');
      if (!btn || !box.contains(btn)) return;
      $$('.seg', box).forEach(b => {
        const on = b === btn;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
      onChange(btn.dataset.value);
    });
  }
  function segValue(containerId) {
    const el = $('#' + containerId + ' .seg.is-active');
    return el ? el.dataset.value : null;
  }

  /* ================================================================== *
   * 3. PDF → 이미지
   * ================================================================== */

  const pdfState = {
    doc: null,
    name: '',
    size: 0,
    pages: 0,
    format: 'png',
    quality: 'normal',
    cache: new Map(),   // "page|format|quality" -> Blob
    previewTask: null,
    busy: false
  };

  const QUALITY = {
    normal: { dpi: 150, label: '보통', note: '약 150dpi — 화면으로 보기 좋아요' },
    high: { dpi: 300, label: '고화질', note: '약 300dpi — 인쇄·보관용, 용량이 커져요' }
  };

  const pdfInput = $('#pdfInput');
  pdfInput.addEventListener('change', () => {
    const file = pdfInput.files && pdfInput.files[0];
    pdfInput.value = '';
    if (file) openPdf(file);
  });

  segmented('formatSeg', v => { pdfState.format = v; pdfState.cache.clear(); });
  segmented('qualitySeg', v => {
    pdfState.quality = v;
    pdfState.cache.clear();
    $('#qualityHint').textContent = QUALITY[v].label + ' · ' + QUALITY[v].note;
  });

  function resetPdfView(keepDoc) {
    if (!keepDoc && pdfState.doc) {
      try { pdfState.doc.destroy(); } catch (e) { /* noop */ }
    }
    pdfState.cache.clear();
    $('#pdfPreview').innerHTML = '';
  }

  async function openPdf(file) {
    if (pdfState.busy) { toast('아직 처리 중이에요. 잠시만 기다려 주세요.'); return; }
    if (!/pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      toast('PDF 파일만 열 수 있어요.');
      return;
    }
    resetPdfView(false);
    pdfState.doc = null;
    pdfState.busy = true;
    $('#pdfActions').classList.add('hidden');
    $('#pdfPreviewHead').classList.add('hidden');
    $('#pdfInfo').classList.remove('hidden');
    $('#pdfName').textContent = file.name;
    $('#pdfMeta').textContent = '여는 중…';
    setProgress('pdf', 0.05, 'PDF 여는 중…');

    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const task = pdfjsLib.getDocument({
        data: data,
        standardFontDataUrl: STANDARD_FONTS,
        isEvalSupported: false,
        disableAutoFetch: true,
        disableStream: true,
        onPassword: (updatePassword) => {
          const pw = window.prompt('이 PDF에는 암호가 걸려 있어요.\n암호를 입력해 주세요.');
          if (pw) updatePassword(pw); else updatePassword(null);
        }
      });
      const doc = await task.promise;
      pdfState.doc = doc;
      pdfState.name = baseName(file.name);
      pdfState.size = file.size;
      pdfState.pages = doc.numPages;

      $('#pdfMeta').textContent = doc.numPages + '페이지 · ' + formatBytes(file.size);
      $('#pdfOptions').classList.remove('hidden');
      $('#pdfPreviewHead').classList.remove('hidden');
      $('#pdfPageCount').textContent = doc.numPages + '페이지' +
        (doc.numPages > MAX_PREVIEW_PAGES ? ' (미리보기는 ' + MAX_PREVIEW_PAGES + '장까지)' : '');

      await renderPreviews(doc);
      hideProgress('pdf');
      $('#pdfActions').classList.remove('hidden');
    } catch (err) {
      console.error(err);
      hideProgress('pdf');
      $('#pdfOptions').classList.add('hidden');
      const name = err && err.name;
      if (name === 'PasswordException') {
        $('#pdfMeta').textContent = '암호가 걸린 PDF예요.';
        toast('암호를 입력하지 않으면 열 수 없어요.');
      } else {
        $('#pdfMeta').textContent = '열 수 없는 파일이에요.';
        toast('PDF를 열 수 없어요. 손상되었거나 지원하지 않는 형식일 수 있어요.', 3400);
      }
    } finally {
      pdfState.busy = false;
    }
  }

  async function renderPreviews(doc) {
    const grid = $('#pdfPreview');
    grid.innerHTML = '';
    const total = Math.min(doc.numPages, MAX_PREVIEW_PAGES);
    for (let n = 1; n <= total; n++) {
      setProgress('pdf', n / total * 0.98, '미리보기 ' + n + ' / ' + total + '페이지');
      let page = null;
      try {
        page = await doc.getPage(n);
        const vp1 = page.getViewport({ scale: 1 });
        const target = 300 * Math.min(window.devicePixelRatio || 1, 2);
        const scale = Math.min(2.2, target / Math.max(vp1.width, vp1.height));
        const viewport = page.getViewport({ scale: scale });

        const cell = document.createElement('div');
        cell.className = 'page-cell';
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: viewport }).promise;

        const num = document.createElement('span');
        num.className = 'page-num';
        num.textContent = n;
        cell.appendChild(canvas);
        cell.appendChild(num);
        cell.appendChild(pageSaveButton(n));
        grid.appendChild(cell);
      } catch (e) {
        console.error('page render failed', n, e);
        const cell = document.createElement('div');
        cell.className = 'page-cell';
        const note = document.createElement('span');
        note.className = 'page-num';
        note.textContent = n + '페이지 실패';
        cell.appendChild(note);
        grid.appendChild(cell);
      } finally {
        if (page) { try { page.cleanup(); } catch (e) { /* noop */ } }
      }
      if (n % 3 === 0) await nextFrame();
    }
    setProgress('pdf', 0.99, '미리보기 완료');
    await nextFrame();
  }

  function pageSaveButton(n) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'page-save';
    btn.textContent = '↓';
    btn.title = n + '페이지 저장';
    btn.setAttribute('aria-label', n + '페이지 이미지로 저장');
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      const before = btn.textContent;
      btn.textContent = '…';
      try {
        const blob = await renderPageBlob(n);
        const ext = pdfState.format === 'png' ? 'png' : 'jpg';
        downloadBlob(blob, pdfState.name + '-p' + String(n).padStart(2, '0') + '.' + ext);
        toast(n + '페이지를 저장했어요.');
      } catch (e) {
        console.error(e);
        toast('저장하지 못했어요. 화면을 새로 고친 뒤 다시 시도해 주세요.');
      } finally {
        btn.textContent = before;
        btn.disabled = false;
      }
    });
    return btn;
  }

  function exportScale(page1Viewport) {
    const dpi = (QUALITY[pdfState.quality] || QUALITY.normal).dpi;
    let scale = dpi / 72;
    const px = page1Viewport.width * scale * page1Viewport.height * scale;
    if (px > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / px);
    return scale;
  }

  async function renderPageBlob(n) {
    const key = n + '|' + pdfState.format + '|' + pdfState.quality;
    if (pdfState.cache.has(key)) return pdfState.cache.get(key);

    const doc = pdfState.doc;
    const page = await doc.getPage(n);
    try {
      const vp1 = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: exportScale(vp1) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: viewport }).promise;

      const isPng = pdfState.format === 'png';
      const blob = await canvasToBlob(canvas, isPng ? 'image/png' : 'image/jpeg', 0.92);
      canvas.width = 0; canvas.height = 0;
      pdfState.cache.set(key, blob);
      return blob;
    } finally {
      try { page.cleanup(); } catch (e) { /* noop */ }
    }
  }

  async function buildAllPages() {
    const total = pdfState.pages;
    const out = [];
    for (let n = 1; n <= total; n++) {
      setProgress('pdf', (n - 1) / total, '이미지 변환 ' + n + ' / ' + total + '페이지');
      const blob = await renderPageBlob(n);
      const ext = pdfState.format === 'png' ? 'png' : 'jpg';
      out.push({ blob: blob, name: pdfState.name + '-p' + String(n).padStart(2, '0') + '.' + ext });
      if (n % 2 === 0) await nextFrame();
    }
    setProgress('pdf', 1, '변환 완료 · ' + total + '장');
    return out;
  }

  function lockPdfButtons(on) {
    pdfState.busy = on;
    ['btnZip', 'btnShare', 'btnEach'].forEach(id => { $('#' + id).disabled = on; });
  }

  $('#btnZip').addEventListener('click', async () => {
    if (!pdfState.doc || pdfState.busy) return;
    lockPdfButtons(true);
    try {
      const pages = await buildAllPages();
      if (typeof JSZip === 'undefined') throw new Error('zip-missing');
      const zip = new JSZip();
      pages.forEach(p => zip.file(p.name, p.blob));
      setProgress('pdf', 1, 'ZIP 만드는 중…');
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      downloadBlob(blob, pdfState.name + '-images-' + stamp() + '.zip');
      toast(pages.length + '장을 ZIP 하나로 저장했어요. 파일 앱에서 풀어 쓰세요.', 3600);
    } catch (err) {
      console.error(err);
      toast('ZIP을 만들지 못했어요. 개별 저장을 이용해 주세요.', 3200);
    } finally {
      hideProgress('pdf');
      lockPdfButtons(false);
    }
  });

  $('#btnShare').addEventListener('click', async () => {
    if (!pdfState.doc || pdfState.busy) return;
    lockPdfButtons(true);
    try {
      const pages = await buildAllPages();
      const files = pages.map(p => new File([p.blob], p.name, { type: p.blob.type }));
      if (canShareFiles() && navigator.canShare({ files: files })) {
        await navigator.share({ files: files, title: pdfState.name + ' 이미지' });
        toast('공유 창을 열었어요.');
      } else {
        toast('이 브라우저에서는 파일 공유를 지원하지 않아요. ZIP 저장을 이용해 주세요.', 3400);
      }
    } catch (err) {
      if (err && err.name === 'AbortError') { /* 사용자가 닫음 */ }
      else if (err && err.name === 'NotAllowedError') {
        toast('아이폰 보안 때문에 공유를 한 번 더 눌러야 할 수 있어요. 다시 눌러 주세요.', 3600);
      } else {
        console.error(err);
        toast('공유를 열지 못했어요. ZIP 저장을 이용해 주세요.', 3200);
      }
    } finally {
      hideProgress('pdf');
      lockPdfButtons(false);
    }
  });

  $('#btnEach').addEventListener('click', async () => {
    if (!pdfState.doc || pdfState.busy) return;
    lockPdfButtons(true);
    try {
      const pages = await buildAllPages();
      for (const p of pages) {
        downloadBlob(p.blob, p.name);
        await new Promise(r => setTimeout(r, 500));
      }
      toast(pages.length + '장을 저장하려고 했어요. 브라우저가 한 번에 여러 장을 막으면 미리보기의 ↓로 한 장씩 저장해 주세요.', 4200);
    } catch (err) {
      console.error(err);
      toast('저장하지 못했어요. 화면을 새로 고친 뒤 다시 시도해 주세요.', 3400);
    } finally {
      hideProgress('pdf');
      lockPdfButtons(false);
    }
  });

  $('#pdfReset').addEventListener('click', () => {
    if (pdfState.busy) return;
    resetPdfView(false);
    pdfState.doc = null;
    pdfState.pages = 0;
    pdfState.name = '';
    $('#pdfInfo').classList.add('hidden');
    $('#pdfOptions').classList.add('hidden');
    $('#pdfPreviewHead').classList.add('hidden');
    $('#pdfActions').classList.add('hidden');
    hideProgress('pdf');
  });

  /* ================================================================== *
   * 4. 이미지 → PDF
   * ================================================================== */

  const imgState = {
    items: [],        // {id, file, name, width, height, rot, thumbCanvas}
    fit: 'a4',
    busy: false,
    result: null      // {blob, name}
  };

  const MAX_IMAGE_PIXELS = 3500; // 긴 변 상한 (PDF 안 이미지 해상도)

  const imgInput = $('#imgInput');
  imgInput.addEventListener('change', async () => {
    const files = Array.from(imgInput.files || []);
    imgInput.value = '';
    if (!files.length) return;
    await addImages(files);
  });

  $('#imgClear').addEventListener('click', () => {
    if (imgState.busy) return;
    imgState.items.forEach(it => { if (it.thumbCanvas) { it.thumbCanvas.width = 0; it.thumbCanvas.height = 0; } });
    imgState.items = [];
    pdfResultReset();
    renderImageList();
  });

  segmented('fitSeg', v => {
    imgState.fit = v;
    $('#fitHint').textContent = v === 'a4'
      ? 'A4 맞춤 · 여백 없이 비율 유지하며 A4 한 장에 담아요'
      : '원본 크기 · 이미지 비율 그대로 여백 없이 담아요 (긴 변 최대 A3)';
    pdfResultReset();
  });

  function pdfResultReset() {
    imgState.result = null;
    $('#pdfResult').classList.add('hidden');
  }

  async function decodeImage(file) {
    if (window.createImageBitmap) {
      try {
        const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
        return {
          source: bmp,
          width: bmp.width,
          height: bmp.height,
          release: () => { try { bmp.close && bmp.close(); } catch (e) { /* noop */ } }
        };
      } catch (e) { /* 아래 Image 방식으로 재시도 */ }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      if (img.decode) await img.decode();
      else await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
      return {
        source: img,
        width: img.naturalWidth,
        height: img.naturalHeight,
        release: () => URL.revokeObjectURL(url)
      };
    } catch (e) {
      URL.revokeObjectURL(url);
      throw e;
    }
  }

  function rotatedCanvas(source, w, h, rot) {
    const swap = rot % 180 !== 0;
    const cw = swap ? h : w;
    const ch = swap ? w : h;
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cw, ch);
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(cw / 2, ch / 2);
    ctx.rotate((rot * Math.PI) / 180);
    ctx.drawImage(source, -w / 2, -h / 2, w, h);
    return canvas;
  }

  async function addImages(files) {
    if (imgState.busy) return;
    imgState.busy = true;
    pdfResultReset();
    setProgress('img', 0, '사진 읽는 중…');
    let failed = 0;
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setProgress('img', i / files.length, '사진 ' + (i + 1) + ' / ' + files.length + ' 준비 중…');
        if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|heic|heif|gif|bmp)$/i.test(file.name)) {
          failed++;
          continue;
        }
        try {
          const dec = await decodeImage(file);
          const w = dec.width;
          const h = dec.height;
          if (!w || !h) throw new Error('empty');
          dec.release();
          imgState.items.push({
            id: 'i' + Date.now().toString(36) + hex4(),
            file: file,
            name: file.name || ('사진 ' + (i + 1)),
            width: w,
            height: h,
            rot: 0,
            thumbCanvas: null
          });
        } catch (e) {
          console.warn('이미지 읽기 실패', file.name, e);
          failed++;
        }
        await nextFrame();
      }
    } finally {
      hideProgress('img');
      imgState.busy = false;
    }
    await rebuildThumbs();
    renderImageList();
    if (failed) {
      toast(failed + '장을 읽지 못했어요. HEIC 원본이면 사진 앱에서 JPEG로 저장한 뒤 다시 골라 주세요.', 4200);
    }
  }

  async function makeThumb(item) {
    const dec = await decodeImage(item.file);
    try {
      const long = Math.max(dec.width, dec.height);
      const k = Math.min(1, 320 / long);
      const w = Math.max(1, Math.round(dec.width * k));
      const h = Math.max(1, Math.round(dec.height * k));
      const c = rotatedCanvas(dec.source, w, h, item.rot);
      item.thumbCanvas = c;
    } finally {
      dec.release();
    }
  }

  async function rebuildThumbs() {
    for (const item of imgState.items) {
      if (!item.thumbCanvas) {
        try { await makeThumb(item); } catch (e) { console.warn(e); }
      }
    }
  }

  function thumbUrl(item) {
    if (!item.thumbCanvas) return '';
    try { return item.thumbCanvas.toDataURL('image/jpeg', 0.8); } catch (e) { return ''; }
  }

  function renderImageList() {
    const list = $('#imgList');
    list.innerHTML = '';
    const items = imgState.items;
    $('#imgOptions').classList.toggle('hidden', items.length === 0);
    $('#imgHead').classList.toggle('hidden', items.length === 0);
    $('#imgActions').classList.toggle('hidden', items.length === 0);
    $('#pdfResult').classList.toggle('hidden', items.length === 0 || !imgState.result);

    items.forEach((item, idx) => {
      const displayW = item.rot % 180 === 0 ? item.width : item.height;
      const displayH = item.rot % 180 === 0 ? item.height : item.width;

      const li = document.createElement('li');
      li.className = 'thumb';

      const badge = document.createElement('span');
      badge.className = 'thumb-idx';
      badge.textContent = idx + 1;
      badge.style.width = '26px';
      badge.style.height = '26px';
      badge.style.borderRadius = '50%';
      badge.style.background = 'var(--brand-soft)';
      badge.style.color = 'var(--brand)';
      badge.style.display = 'flex';
      badge.style.alignItems = 'center';
      badge.style.justifyContent = 'center';
      badge.style.fontSize = '.78rem';
      badge.style.fontWeight = '800';
      badge.style.flex = 'none';

      const img = document.createElement('img');
      img.className = 'thumb-img';
      img.alt = '사진 ' + (idx + 1) + ' 미리보기';
      img.src = thumbUrl(item);
      img.width = 66;
      img.height = 66;

      const body = document.createElement('div');
      body.className = 'thumb-body';
      const name = document.createElement('div');
      name.className = 'thumb-name';
      name.textContent = item.name;
      const info = document.createElement('div');
      info.className = 'thumb-info';
      info.textContent = displayW + '×' + displayH + (item.rot ? ' · ' + item.rot + '°' : '');
      body.appendChild(name);
      body.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'thumb-actions';

      const up = button('↑', '위로', () => moveItem(idx, -1), idx === 0);
      const down = button('↓', '아래로', () => moveItem(idx, 1), idx === items.length - 1);
      const rot = button('↻', '90도 회전', () => rotateItem(item));
      const del = button('✕', '삭제', () => removeItem(item));
      del.classList.add('danger');
      del.style.color = 'var(--danger)';

      actions.appendChild(up);
      actions.appendChild(down);
      actions.appendChild(rot);
      actions.appendChild(del);

      li.appendChild(badge);
      li.appendChild(img);
      li.appendChild(body);
      li.appendChild(actions);
      list.appendChild(li);
    });
  }

  function button(label, aria, onClick, disabled) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon-btn';
    b.textContent = label;
    b.setAttribute('aria-label', aria);
    b.title = aria;
    b.disabled = !!disabled;
    b.addEventListener('click', onClick);
    return b;
  }

  function moveItem(idx, dir) {
    const to = idx + dir;
    if (to < 0 || to >= imgState.items.length) return;
    const items = imgState.items;
    const [moved] = items.splice(idx, 1);
    items.splice(to, 0, moved);
    pdfResultReset();
    renderImageList();
  }

  async function rotateItem(item) {
    item.rot = (item.rot + 90) % 360;
    if (item.thumbCanvas) {
      const old = item.thumbCanvas;
      const c = document.createElement('canvas');
      const swap = item.rot % 180 !== 0;
      c.width = swap ? old.height : old.width;
      c.height = swap ? old.width : old.height;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.translate(c.width / 2, c.height / 2);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(old, -old.width / 2, -old.height / 2);
      old.width = 0; old.height = 0;
      item.thumbCanvas = c;
    }
    pdfResultReset();
    renderImageList();
  }

  function removeItem(item) {
    imgState.items = imgState.items.filter(x => x.id !== item.id);
    if (item.thumbCanvas) { item.thumbCanvas.width = 0; item.thumbCanvas.height = 0; }
    pdfResultReset();
    renderImageList();
  }

  async function buildPdfBlob() {
    if (!window.PDFLib) throw new Error('pdf-lib-missing');
    const { PDFDocument } = PDFLib;
    const doc = await PDFDocument.create();
    doc.setProducer('PDF ↔ 이미지 (기기 내 처리)');
    doc.setCreator('PDF ↔ 이미지 웹앱');

    const A4_W = 595.28;
    const A4_H = 841.89;
    const ORIG_MAX_LONG = 1190; // A3 긴 변

    const items = imgState.items.slice();
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      setProgress('img', i / items.length, 'PDF 만드는 중 ' + (i + 1) + ' / ' + items.length + '페이지');

      const dec = await decodeImage(item.file);
      let canvas = null;
      try {
        let w = dec.width;
        let h = dec.height;
        const long = Math.max(w, h);
        const k = long > MAX_IMAGE_PIXELS ? MAX_IMAGE_PIXELS / long : 1;
        w = Math.max(1, Math.round(w * k));
        h = Math.max(1, Math.round(h * k));
        canvas = rotatedCanvas(dec.source, w, h, item.rot);
      } finally {
        dec.release();
      }

      const pngSource = /^image\/png$/i.test(item.file.type) || /\.png$/i.test(item.name);
      const blob = await canvasToBlob(canvas, pngSource ? 'image/png' : 'image/jpeg', 0.92);
      canvas.width = 0; canvas.height = 0;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const embedded = pngSource ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);

      if (imgState.fit === 'a4') {
        const page = doc.addPage([A4_W, A4_H]);
        const s = Math.min(A4_W / embedded.width, A4_H / embedded.height);
        const dw = embedded.width * s;
        const dh = embedded.height * s;
        page.drawImage(embedded, {
          x: (A4_W - dw) / 2,
          y: (A4_H - dh) / 2,
          width: dw,
          height: dh
        });
      } else {
        let pw = embedded.width * 0.75;
        let ph = embedded.height * 0.75;
        const scale = Math.min(1, ORIG_MAX_LONG / Math.max(pw, ph));
        pw = Math.max(1, pw * scale);
        ph = Math.max(1, ph * scale);
        const page = doc.addPage([pw, ph]);
        page.drawImage(embedded, { x: 0, y: 0, width: pw, height: ph });
      }
      if (i % 2 === 0) await nextFrame();
    }

    setProgress('img', 0.98, '마무리 중…');
    const out = await doc.save();
    return new Blob([out], { type: 'application/pdf' });
  }

  async function renderResultPreview(blob) {
    const canvas = $('#resultPreview');
    const ctx = canvas.getContext('2d');
    canvas.width = 0; canvas.height = 0;
    if (!window.pdfjsLib) return;
    try {
      const data = new Uint8Array(await blob.arrayBuffer());
      const doc = await pdfjsLib.getDocument({
        data: data,
        standardFontDataUrl: STANDARD_FONTS,
        isEvalSupported: false
      }).promise;
      const page = await doc.getPage(1);
      const vp1 = page.getViewport({ scale: 1 });
      const scale = Math.min(2, 800 / vp1.width);
      const viewport = page.getViewport({ scale: scale });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const c2 = canvas.getContext('2d', { alpha: false });
      c2.fillStyle = '#fff';
      c2.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: c2, viewport: viewport }).promise;
      const pages = doc.numPages;
      try { page.cleanup(); doc.destroy(); } catch (e) { /* noop */ }
      return pages;
    } catch (e) {
      console.warn('미리보기 실패', e);
      return 0;
    }
  }

  $('#btnMakePdf').addEventListener('click', async () => {
    if (imgState.busy) return;
    if (!imgState.items.length) { toast('먼저 사진을 골라 주세요.'); return; }

    imgState.busy = true;
    $('#btnMakePdf').disabled = true;
    $('#btnMakePdf').textContent = '만드는 중…';
    pdfResultReset();
    try {
      const blob = await buildPdfBlob();
      const name = '이미지-' + stamp() + '.pdf';
      imgState.result = { blob: blob, name: name };
      $('#resultName').textContent = name + ' · ' + formatBytes(blob.size);
      $('#pdfResult').classList.remove('hidden');
      const pages = await renderResultPreview(blob);
      hideProgress('img');
      toast((pages || imgState.items.length) + '페이지 PDF를 만들었어요. 저장을 누르면 파일 앱에 담깁니다.', 3600);
    } catch (err) {
      console.error(err);
      hideProgress('img');
      toast('PDF를 만들지 못했어요. 사진 수를 줄이거나 화면을 새로 고친 뒤 다시 시도해 주세요.', 4000);
    } finally {
      imgState.busy = false;
      $('#btnMakePdf').disabled = false;
      $('#btnMakePdf').textContent = 'PDF 하나로 만들기';
    }
  });

  $('#btnSavePdf').addEventListener('click', () => {
    if (!imgState.result) return;
    downloadBlob(imgState.result.blob, imgState.result.name);
    toast('저장을 시작했어요. 파일 앱 > 다운로드에서 확인하세요.', 3600);
  });

  $('#btnSharePdf').addEventListener('click', async () => {
    if (!imgState.result) return;
    const file = new File([imgState.result.blob], imgState.result.name, { type: 'application/pdf' });
    try {
      if (canShareFiles() && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: imgState.result.name });
      } else {
        downloadBlob(imgState.result.blob, imgState.result.name);
        toast('이 브라우저는 공유를 지원하지 않아 저장했어요.', 3200);
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      console.error(err);
      downloadBlob(imgState.result.blob, imgState.result.name);
      toast('공유를 열지 못해 저장했어요.', 3200);
    }
  });

  /* ------------------------------------------------------------------ *
   * 5. 서비스 워커 (오프라인)
   * ------------------------------------------------------------------ */

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(err => {
        console.warn('서비스 워커 등록 실패', err);
      });
    });
  }

})();
