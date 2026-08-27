# Private Excalidraw Workspace

개인/소규모 팀을 위한 자체 호스팅(Self-Hosted) Excalidraw 작업 공간입니다.

외부 클라우드 종속성 없이 단일 Docker 컨테이너 및 로컬 디렉토리(`/data`) 기반으로 모든 문서, 버전 스냅샷, 첨부 이미지, 사용자 세션을 안전하게 영속화합니다.

---

## 주요 기능

- **Excalidraw 캔버스 연동**: 화이트보드 드로잉, 도형, 텍스트, 라이트/다크 테마
- **자동 저장 & 로컬 캐싱**:
  - 3초 디바운스 서버 자동 저장
  - 브라우저 실시간 `localStorage` 캐싱 및 탭 닫기 시 즉시 flush (Zero Data Loss)
  - `Ctrl + S` / `Cmd + S` 즉시 수동 저장 및 스냅샷 생성
- **버전 관리 (Version History)**: 최대 20개 스냅샷 유지, 과거 버전 미리보기 및 1-클릭 롤백
- **실제 캔버스 썸네일 미리보기**: 캔버스에 그린 실제 내용을 400px PNG 썸네일로 실시간 생성 및 대시보드 표시
- **공유 및 권한 관리**:
  - 사용자 지정 공유 (`VIEWER` 권한)
  - 만료일 지정 가능한 익명 읽기 전용 공개 공유 링크 (`/share/[token]`)
  - 소유권 원자적 이전 (Transfer Ownership)
- **휴지통 및 파일 수명주기**: Soft delete, 휴지통 복원, 영구 삭제 시 파일 시스템 GC
- **관리자 모드 (Admin Mode)**: 전체 사용자 생성/비활성화/비밀번호 재설정 및 시스템 전체 문서 관리
- **Import / Export**: 공식 `.excalidraw` 파일 호환 내보내기/가져오기

---

## 빠른 시작

### 1. Docker Compose (권장)

```bash
# 최신 이미지로 실행 (기본 latest)
docker compose up -d

# 또는 특정 브랜치/태그로 실행 (예: master, main)
TAG=master docker compose up -d
```

실행 후 브라우저에서 `http://localhost:3000`에 접속하여 기본 관리자 계정으로 로그인합니다:
- **Username**: `admin`
- **Password**: `admin1234!` (또는 `docker-compose.yml`에서 설정한 값)

### 2. 로컬 개발 환경

```bash
# 의존성 설치
npm install

# 테스트 실행
npm test

# 개발 서버 실행
npm run dev
```

---

## 문서 (Documentation)

- [구현 계획서](docs/implement_plan.md)
- [기능 검증 체크리스트](docs/CHECKLIST.md)
- [추후 과제 및 팔로업](docs/TODO_FOLLOWUP.md)
