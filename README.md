# Paragraph Translator

CEFR 수준에 맞춰 영어 웹페이지에서 어려운 단어만 형광펜하고, 문단 아래 한국어 뜻을 붙이는 Chrome 확장 (MVP).

## 구조

- `extension/` — Manifest V3 Chrome extension
- `supabase/functions/` — `annotate`, `define` (Gemini 3.8 Flash 프록시)
- `supabase/migrations/` — `usage_daily` 일일 쿼터 테이블

## 로컬에서 확장 로드

1. Chrome → `chrome://extensions` → 개발자 모드 ON
2. **압축해제된 확장 프로그램을 로드합니다** → `extension/` 폴더 선택

## 개발자 설정 (UI에 넣지 않음)

1. Google Cloud에서 OAuth 클라이언트(**웹 애플리케이션**) 생성  
   Redirect URI: `https://kcdlckibjellpjeoalndnabcnbhipcac.chromiumapp.org`
2. `extension/config.js`의 `GOOGLE_OAUTH_CLIENT_ID`에 Client ID 기입
3. 같은 Client ID/Secret을 Supabase → Authentication → Google에 설정
4. Supabase에 `GEMINI_API_KEY` 시크릿 · `annotate`/`define` 배포 · `usage_daily` 테이블

## 사용자 사용 방법

1. **구글로 로그인하기**
2. 레벨 슬라이더 (A1–C2)
3. **active** 토글 ON → Gemini가 문단을 주석
4. 텍스트 선택 후 우클릭 → **단어 추가**

## 비범위 (이후)

- Supabase 단어장 동기화 / 모바일 복습
- PDF 지원
