# Private Excalidraw Workspace — Todo Followup & Verification Report

## 1. 개요 및 체크리스트 검증 결과 요약

`implement_plan.md` 및 `CHECKLIST.md`에 정의된 10개 핵심 영역에 대해 소스 코드 전수 감사(Full Audit) 및 빌드 검증을 수행하였습니다.

| 구분 | 영역 | 상태 | 세부 구현 파일 |
|---|---|---|---|
| Phase 1 | 아키텍처 & 프로젝트 기반 (Next.js 14, Node 24 `node:sqlite`, `/data` 볼륨, Dockerfile, docker-compose) | ✅ **구현 완료 & 빌드 통과** | `package.json`, `Dockerfile`, `docker-compose.yml`, `src/lib/config.ts` |
| Phase 2 | 데이터베이스 스키마 & 마이그레이션 (7개 테이블, WAL 모드, 외래키 ON, 인덱스) | ✅ **구현 완료** | `src/lib/db.ts`, `src/lib/types.ts` |
| Phase 3 | 인증 및 사용자 관리 (bcrypt 해싱, 쿠키 세션, 관리자 Bootstrap, Admin 전용 유저 관리) | ✅ **구현 완료** | `src/lib/users.ts`, `src/lib/passwords.ts`, `src/app/api/auth/*`, `src/app/api/admin/users/*` |
| Phase 4 | 문서 관리 & 권한 엔진 (3단계 권한, 원자적 소유권 이전, Trash Soft Delete, Permanent Delete & File GC) | ✅ **구현 완료** | `src/lib/documents.ts`, `src/lib/trash.ts`, `src/app/api/documents/*` |
| Phase 5 | Excalidraw 에디터, 저장 & 버전 (3초 디바운스 자동 저장, 5분 스냅샷 정책, 수동 즉시 스냅샷, 최근 20개 히스토리, PNG 썸네일) | ✅ **구현 완료** | `src/lib/versions.ts`, `src/lib/thumbnails.ts`, `src/components/ExcalidrawCanvas.tsx`, `src/app/documents/[id]/EditorClient.tsx` |
| Phase 6 | 첨부파일 및 에셋 관리 (`/data/attachments/<docId>/`, 버전 안전 파일 보존 규칙) | ✅ **구현 완료** | `src/lib/attachments.ts`, `src/app/api/attachments/*` |
| Phase 7 | 공유 & 읽기 전용 뷰어 (VIEWER 공유, 익명 공개 링크 만료/회전, Read-only 뷰어 모드) | ✅ **구현 완료** | `src/lib/share_links.ts`, `src/app/share/[token]/*`, `src/app/api/share/*` |
| Phase 8 | Import / Export (표준 `.excalidraw` 호환 내보내기/가져오기) | ✅ **구현 완료** | `src/lib/exc_io.ts`, `src/app/api/documents/import/*`, `src/app/api/documents/[id]/export/*` |
| Phase 9 | 대시보드 UI & Admin Mode (My Documents, Shared With Me, Trash, Admin Mode 패널) | ✅ **구현 완료** | `src/app/dashboard/DashboardClient.tsx`, `src/app/dashboard/AdminPanel.tsx` |
| Phase 10 | 자동화 테스트 스위트 (20개 성공 시나리오 Vitest) | ⏳ **후속 작업 필요** | `tests/` 디렉토리 및 테스트 파일 미작성 상태 (`No test files found`) |

---

## 2. 남은 과제 (TODO Followup Tasks)

개발용 제미나이 터미널에서 진행할 후속 작업 항목입니다.

### 🎯 Task 1. 요구사항 28장 20개 성공 시나리오 자동화 테스트 스위트 작성
`tests/scenarios.test.ts` (또는 `tests/mvp-scenarios.test.ts`) 파일에 다음 20개 시나리오를 검증하는 Vitest 단위/통합 테스트를 작성합니다.

- [ ] **Scenario 1-2**: `bootstrapAdmin` 환경변수 기반 관리자 계정 생성 및 중복 생성 방지 검증
- [ ] **Scenario 3**: 관리자의 신규 유저 생성 (`createUser`) 및 일반 사용자 회원가입 불가 검증
- [ ] **Scenario 4-5**: 사용자 로그인 (`createSession`, 세션 검증) 및 Dashboard 로딩 메타데이터 검증
- [ ] **Scenario 6-7**: 신규 Excalidraw 문서 생성 (`createDocument`, OWNER 부여, 기본 Private)
- [ ] **Scenario 8**: 디바운스 자동 저장 (`updateScene` — 버전 스냅샷 생성 없이 현재 씬 갱신)
- [ ] **Scenario 9**: 수동 저장 (`createSnapshotFromDoc` / `/api/documents/[id]/save` — 즉시 스냅샷 생성)
- [ ] **Scenario 10**: 세션 만료 전 재로그인 및 문서 재오픈 검증
- [ ] **Scenario 11**: 버전 스냅샷 히스토리 조회 (`listVersions`, 최대 20개) 및 이전 버전 복원 (`restoreVersion`)
- [ ] **Scenario 12**: 첨부 이미지 업로드 (`storeAttachment`) 및 이전 버전 복원 시 이미지 참조 유지 검증
- [ ] **Scenario 13**: 문서 Trash 이동 (`softDelete`), 복원 (`restoreDocument`), 영구 삭제 (`permanentDelete` 시 DB/파일 완전 정리)
- [ ] **Scenario 14**: 다른 사용자에게 VIEWER 권한으로 문서 공유 (`addMember`)
- [ ] **Scenario 15**: VIEWER 권한 사용자 수정 불가(`requireWrite` 차단) 및 읽기 허용(`requireRead`)
- [ ] **Scenario 16**: 익명 읽기 전용 share link 생성, 만료일 설정, 토큰 재생성(회전) 및 비활성화 검증
- [ ] **Scenario 17**: 비로그인 상태에서 share link 토큰으로 문서 조회 (`getValidShareLinkByToken`)
- [ ] **Scenario 18**: `.excalidraw` 포맷 JSON export 및 import (`exportSceneAsExcalidrawJson`, `importExcalidrawJson`)
- [ ] **Scenario 19**: `/data` 경로에 `app.db`, `attachments/`, `thumbnails/` 파일이 정상 영속화되는지 검증
- [ ] **Scenario 20**: 관리자(Admin)의 Admin Mode 전체 문서 조회/수정/삭제 및 소유권 이전(`transferOwnership`) 검증

### 🎯 Task 2. Vitest 테스트 실행 및 100% 패스 확인
```bash
npm test
```
모든 20개 시나리오 테스트가 통과하는지 확인합니다.

### 🎯 Task 3. 빌드 및 타입 무결성 최종 확인
```bash
npm run typecheck
npm run build
```
경고 및 에러 없이 클린하게 빌드되는지 확인합니다.

---

## 3. 실행 가이드 for Gemini 터미널

Gemini 터미널에서 다음 명령으로 테스트를 작성하고 실행해 주세요:
1. `tests/mvp-scenarios.test.ts` 작성
2. `npm test` 실행하여 20개 성공 시나리오 전체 패스 확인
3. `CHECKLIST.md`의 Phase 10 체크박스 업데이트 및 커밋