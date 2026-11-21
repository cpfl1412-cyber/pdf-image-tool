# PDF ↔ 이미지

PDF를 페이지별 이미지로 풀거나, 사진 여러 장을 PDF 하나로 묶는 **아이폰용 웹앱(PWA)**입니다.
계약서·신분증 사본처럼 민감한 서류를 외부 변환 사이트에 올리지 않고 **기기 안에서만** 처리합니다.

- 설치 없이 Safari로 열고, **홈 화면에 추가**하면 앱처럼 쓸 수 있습니다.
- 파일은 서버로 전송되지 않습니다. 앱에는 업로드 기능 자체가 없고, 변환은 전부 브라우저 안에서 이뤄집니다.
- 한 번 열어두면 비행기 모드에서도 동작합니다(서비스 워커 캐시).

## 기능

### PDF → 이미지
- PDF 1개 선택 → 페이지별 Canvas 렌더링, 미리보기 그리드
- 형식: **PNG / JPG**, 화질: **보통(약 150dpi) / 고화질(약 300dpi)**
- 저장 방식: **ZIP 한 번에 저장**, **iOS 공유 시트**(`navigator.share`), **개별 저장**
- 암호가 걸린 PDF는 암호를 입력해 열 수 있습니다.

### 이미지 → PDF
- 사진 여러 장 선택(`image/*`, `multiple`) → 썸네일 미리보기
- 순서 위/아래 이동, 90° 회전, 삭제
- 페이지 크기: **A4 맞춤**(비율 유지, A4 안에 꽉 차게) / **원본 크기**(여백 없이, 긴 변 최대 A3)
- 완성된 PDF 첫 페이지 미리보기 + 저장/공유

## 구조

```
index.html            화면
styles.css            모바일 퍼스트 스타일 (safe-area 대응, 다크 모드)
app.js                모든 변환 로직 (브라우저 안에서만 실행)
sw.js                 오프라인 캐시
manifest.webmanifest  PWA 매니페스트
icons/                앱 아이콘 (180/192/512/maskable)
vendor/               외부 CDN 없이 저장소에 포함한 라이브러리
  pdf.min.js, pdf.worker.min.js   PDF.js 3.11.174 (PDF 렌더링)
  pdf-lib.min.js                  pdf-lib 1.17.1 (PDF 생성)
  jszip.min.js                    JSZip 3.10.1 (ZIP 묶기)
  standard_fonts/                 PDF.js 표준 폰트 (내장 폰트 없는 PDF 대비)
tools/gen_icons.py    아이콘 생성 스크립트
test/                 동작 확인용 샘플 사진·PDF
```

## 아이폰에서 앱처럼 쓰기

1. Safari에서 이 페이지를 엽니다.
2. 하단 **공유** 버튼 → **홈 화면에 추가**.
3. 홈 화면 아이콘으로 열면 주소창 없이 전체 화면으로 뜹니다.

## 개발 메모

- 아이폰 Safari는 `<canvas>` 한 장의 픽셀 수에 제한이 있어, 고화질 변환 시 페이지당 최대 1,200만 픽셀로 자동 제한합니다.
- 사진은 EXIF 회전 정보를 반영해 디코딩한 뒤 PDF에 넣습니다(눕거나 뒤집히지 않음).
- Apple 기기에서 고른 HEIC 사진은 Safari가 JPEG로 변환해 전달합니다. 읽지 못한 파일이 있으면 화면에서 알려 줍니다.

## 라이선스

앱 코드: MIT.
포함한 라이브러리는 각자의 라이선스를 따릅니다 — `vendor/LICENSE-pdfjs.txt`(Apache-2.0),
`vendor/LICENSE-pdf-lib.md`(MIT), `vendor/LICENSE-jszip.md`(MIT/GPLv3, 이 프로젝트는 MIT 조건 사용).
