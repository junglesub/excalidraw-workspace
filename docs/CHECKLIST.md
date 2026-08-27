# Private Excalidraw Workspace 구현 및 검증 체크리스트

`implement_plan.md` 요구사항 및 20개 성공 기준(Section 28)을 바탕으로 정의된 단계별 구현 및 품질 검증 체크리스트입니다.

---

## 1. 아키텍처 및 프로젝트 기반 설정 (Foundation)

- [x] **기술 스택 확정 및 프로젝트 초기화**
  - [x] Full-stack 프레임워크 선정 (Next.js App Router + TypeScript + Tailwind CSS)
  - [x] SQLite ORM/드라이버 선정 — Node 24 내장 `node:sqlite` (Better-SQLite3/Drizzle/Prisma 대체, 네이티브 컴파일 불필요)
  - [x] `@excalidraw/excalidraw` 패키지 의존성 연동 및 dynamic import / client-only 래핑 구성
- [x] **데이터 디렉토리 및 영속성 구조 설정**
  - [x] `/data` 단일 영속 볼륨 구조화 (`/data/app.db`, `/data/attachments/<doc-id>/`, `/data/thumbnails/`)
  - [x] 환경변수 기반 데이터 경로 설정 (`DATA_DIR=/data` or `./data`)
- [x] **도커 배포 환경 구성**
  - [x] Multi-stage `Dockerfile` 작성 (경량 Node 런타임 및 SQLite 바이너리 호환성 확보)
  - [x] `docker-compose.yml` 작성 (단일 서비스, `./data:/data` 볼륨 마운트, 포트 매핑)

---

## 2. 데이터베이스 스키마 및 마이그레이션 (Data Modeling)

- [x] **DB Schema 정의**
  - [x] `users`: id, username (unique), password_hash, role (`USER` | `ADMIN`), is_active, created_at, updated_at
  - [x] `documents`: id, title, owner_id (FK), scene (JSON), thumbnail_path, created_at, updated_at, deleted_at (soft delete)
  - [x] `document_members`: id, document_id (FK), user_id (FK), permission (`OWNER` | `EDITOR` | `VIEWER`), created_at, updated_at
  - [x] `document_versions`: id, document_id (FK), version_number, scene (JSON), thumbnail_path, created_by (FK), created_at
  - [x] `attachments`: id, document_id (FK), file_name, file_size, mime_type, file_path, sha256, created_at
  - [x] `share_links`: id, document_id (FK, unique), token (unique), permission (`VIEWER`), expires_at (nullable), is_active, created_at
  - [x] `sessions`: id, user_id (FK), token, expires_at, created_at
- [x] **마이그레이션 및 초기화 루틴**
  - [x] 서버 시작 시 DB 자동 마이그레이션 / 스키마 초기화
  - [x] 외래키 제약조건(Foreign Keys ON) 및 WAL 모드 활성화

---

## 3. 인증 및 사용자 관리 (Auth & User Management)

- [x] **비밀번호 보안 & 세션 인증**
  - [x] `bcrypt` / `argon2` 기반 비밀번호 해싱 및 검증 — `bcryptjs` 사용
  - [x] HttpOnly, Secure, SameSite Cookie 기반 세션 관리 (로그인 / 로그아웃)
  - [x] 비인가 요청에 대한 미들웨어 / Guard 인터셉트 (`requireUser`, `requireAdmin`)
- [x] **최초 관리자 Bootstrap**
  - [x] 서버 기동 시 `ADMIN_USERNAME`, `ADMIN_PASSWORD` 환경변수 검사
  - [x] 관리자 계정 부재 시에만 자동 생성 (기존 계정 존재 시 덮어쓰기 방지)
- [x] **사용자 관리 (Admin 전용)**
  - [x] 관리자 전용 사용자 목록 조회 API & UI
  - [x] 관리자 전용 신규 사용자 생성 API & UI (공개 회원가입 없음)
  - [x] 관리자 전용 사용자 비활성화/삭제 API
  - [x] 관리자 전용 사용자 비밀번호 강제 재설정 API
- [x] **사용자 본인 기능**
  - [x] 로그인 사용자 본인 비밀번호 변경 기능

---

## 4. 문서 관리 및 권한 엔진 (Document & Permissions Engine)

- [x] **권한 검증 레이어 (Authorization Layer)**
  - [x] 권한 3단계(`OWNER`, `EDITOR`, `VIEWER`) 검증 로직 구현
  - [x] Admin 권한 (일반 모드 vs Admin Mode 격리)
    - [x] 일반 모드: 본 문서 + 공유받은 문서만 접근
    - [x] Admin Mode: 시스템 전체 문서 조회/수정/삭제 및 소유권 관리
- [x] **문서 CRUD**
  - [x] 새 문서 생성 (생성자 = OWNER, 기본 Private)
  - [x] 문서 제목 수정 / 단일 문서 메타데이터 조회
  - [x] 문서 소유권 이전 (OWNER -> 대상 사용자, 이전 OWNER는 EDITOR로 원자적(Transaction) 변경)
- [x] **휴지통 및 삭제 라이프사이클 (Trash & Cleanup)**
  - [x] Soft delete (삭제 시 `deleted_at` 기록 및 Trash 이동)
  - [x] 휴지통 목록 조회 및 복원(Restore)
  - [x] 영구 삭제(Permanent delete) 트랜잭션:
    - [x] 문서 레코드 삭제
    - [x] 버전 히스토리 레코드 삭제
    - [x] 멤버십 및 공유 링크 삭제
    - [x] 첨부파일 및 썸네일 물리 파일 정리 (GC)

---

## 5. Excalidraw 에디터, 저장 및 버전 관리 (Editor, Storage & Versions)

- [x] **Excalidraw React Wrapper**
  - [x] `@excalidraw/excalidraw` 캔버스 컴포넌트 렌더링 (`ExcalidrawCanvas.tsx`)
  - [x] 다크/라이트 테마 및 기본 UI 연동
  - [x] 편집 모드 (OWNER / EDITOR) vs 읽기 전용 뷰어 모드 (VIEWER / Share link) 분기 처리
- [x] **저장 파이프라인 (Auto-save & Manual Save)**
  - [x] **자동 저장(Auto-save)**: 편집 이벤트 후 3초 debounce 적용, 현재 상태 DB 갱신 (`/scene` 라우트)
  - [x] **자동 스냅샷 정책**: 자동 저장 시 5분 경과 한 때에만 새 snapshot 생성 (`versions.ts`)
  - [x] **수동 저장(Manual Save)**: 'Save' 클릭 즉시 저장 및 새 version snapshot 즉시 생성 (`/save` 라우트)
- [x] **버전 히스토리 (Version History)**
  - [x] 문서별 최대 최근 20개 스냅샷 유지 (20개 초과 시 정리) (`MAX_VERSIONS`)
  - [x] 버전 히스토리 사이드바/모달 (스냅샷 목록, 생성 시각, 생성자, 썸네일)
  - [x] 과거 버전 미리보기 및 특정 버전 복원 (복원 시 새로운 현재 상태로 커밋)
- [x] **썸네일 생성 및 캐싱 (Thumbnails)**
  - [x] 수동 저장 및 스냅샷 생성 시 PNG 썸네일 렌더링/저장 (`/data/thumbnails/<doc-id>.png`) (`thumbnails.ts`)
  - [x] 목록 화면에서 저장된 썸네일 이미지 서빙 (`/api/thumbnails/[...path]`)

---

## 6. 첨부파일 및 이미지 관리 (Attachments & Assets)

- [x] **이미지 업로드 및 서빙 API**
  - [x] Excalidraw 이미지 삽입 시 `/data/attachments/<doc-id>/<file-id>` 로컬 저장
  - [x] DB `attachments` 테이블에 파일 메타데이터 및 문서 참조 기록
  - [x] 정적 파일 서빙 엔드포인트 구현 (권한 체크 포함)
- [x] **버전 안전 파일 보존 규칙 (Version-Safe File Retention)**
  - [x] 현재 scene에서 이미지가 삭제되어도 보존 중인 과거 버전 snapshot에서 참조 중이면 파일 유지
  - [x] 현재 문서 및 모든 snapshot 어디에서도 참조되지 않을 때만 물리적 파일 삭제

---

## 7. 공유 및 읽기 전용 뷰어 (Sharing & Read-Only Viewer)

- [x] **사용자 지정 공유 (User Sharing)**
  - [x] OWNER가 시스템 내 다른 사용자에게 VIEWER 권한으로 문서 공유
  - [x] 공유 대상 사용자 목록 조회 및 공유 해제
- [x] **공개 공유 링크 (Public Share Link)**
  - [x] OWNER의 익명 읽기 전용 공유 링크 생성 (문서당 최대 1개 활성 링크)
  - [x] 선택적 만료일(Expiration Date) 설정 및 검증 (만료 시 접근 차단)
  - [x] 링크 재생성 (이전 토큰 즉시 무효화) 및 링크 비활성화
- [x] **읽기 전용 뷰어 화면 (Read-Only Viewer)**
  - [x] 비로그인 사용자 또는 VIEWER 권한 사용자를 위한 전용 뷰어 페이지 (`/share/[token]`)
  - [x] 캔버스 탐색(Pan, Zoom) 허용, 편집 도구 및 저장 기능 비활성화

---

## 8. Import / Export (호환성)

- [x] **Export 기능**
  - [x] 현재 문서를 표준 `.excalidraw` JSON 파일로 다운로드 (공식 Excalidraw와 호환)
- [x] **Import 기능**
  - [x] 로컬 `.excalidraw` 파일 업로드 시 새 문서로 파싱 및 생성

---

## 9. 대시보드 UI 및 관리자 모드 (Dashboard & Admin UI)

- [x] **Dashboard 레이아웃 및 탭**
  - [x] **My Documents**: 본인 소유 문서 그리드/리스트 (제목 검색, 썸네일, 수정일)
  - [x] **Shared With Me**: 공유받은 문서 목록 (VIEWER 배지)
  - [x] **Trash**: 삭제된 문서 목록, 개별 복원 / 영구 삭제 버튼
  - [x] **Admin Mode**: 관리자 계정 전용 토글/진입 메뉴
- [x] **Admin Mode 대시보드**
  - [x] 전체 사용자 계정 관리 뷰 (생성, 비활성화, 비밀번호 재설정)
  - [x] 시스템 전체 문서 열람, 편집, 삭제, 소유권 관리 뷰

---

## 10. 자동화 테스트 및 20개 성공 기준 검증 (Automated Tests & Quality Gate)

- [x] **단위 및 통합 테스트 스위트 구축 (Vitest)**
  - [x] **[시나리오 1-2]** Docker Compose 기동 및 환경변수 기반 관리자 계정 생성 검증 (`tests/auth.test.ts`)
  - [x] **[시나리오 3-5]** 관리자의 신규 유저 생성, 로그인, 대시보드 렌더링 검증 (`tests/auth.test.ts`)
  - [x] **[시나리오 6-8]** 새 문서 생성, 에디터 동작, 3초 디바운스 자동 저장 검증 (`tests/documents.test.ts`)
  - [x] **[시나리오 9-10]** 수동 Save 즉시 저장 및 세션 재접속 시 문서 유지 검증 (`tests/documents.test.ts`)
  - [x] **[시나리오 11-12]** 버전 스냅샷 복원 및 첨부 이미지 보존/복원 검증 (`tests/versions.test.ts`, `tests/export_import.test.ts`)
  - [x] **[시나리오 13]** 문서 삭제 후 Trash 이동 및 복원 검증 (`tests/documents.test.ts`)
  - [x] **[시나리오 14-15]** 다른 사용자 VIEWER 공유 및 수정 불가 권한 검증 (`tests/documents.test.ts`, `tests/share.test.ts`)
  - [x] **[시나리오 16-17]** 비로그인 익명 share link 생성 및 읽기 전용 접근 검증 (`tests/share.test.ts`)
  - [x] **[시나리오 18]** `.excalidraw` import / export 무결성 검증 (`tests/export_import.test.ts`)
  - [x] **[시나리오 19]** `/data` 볼륨 보존 상태에서 컨테이너 재시작 시 데이터 유지 검증 (`tests/documents.test.ts`)
  - [x] **[시나리오 20]** Admin Mode에서 전체 사용자 및 문서 관리 권한 검증 (`tests/documents.test.ts`, `tests/auth.test.ts`)
- [x] **빌드 및 린트 검증**
  - [x] TypeScript 타입 체크 (`tsc --noEmit`) 통과
  - [x] 프로덕션 빌드 (`npm run build`) 성공
  - [x] 자동화 테스트 스위트 (`npm test`) 26개 테스트 전체 통과 (6 suites, 26 passed)
  - [x] `git status --short` 및 `git diff --check` 클린 상태 확인