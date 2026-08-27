# Private Excalidraw Workspace 요구사항 문서

## 1. 목적

Excalidraw를 내장한 self-hosted 웹 애플리케이션을 구축한다.

사용자는 브라우저에서 Excalidraw 문서를 생성하고 서버에 저장한 뒤, 대시보드에서 다시 불러와 편집할 수 있어야 한다.

서비스는 개인 및 소규모 사용자 그룹을 대상으로 하며, 복잡한 SaaS 기능보다 다음을 우선한다.

- 간단한 self-hosting
- 안정적인 문서 저장
- 문서 버전 복구
- 다중 사용자 계정
- 명확한 문서 소유권과 공유 권한
- 읽기 전용 공유
- 향후 공동 편집 및 실시간 협업 확장이 가능한 구조

Excalidraw 자체를 fork하지 않고 공식 `@excalidraw/excalidraw` 패키지를 애플리케이션 내부에 내장한다.

---

## 2. 기술 방향

### 애플리케이션

새로운 wrapper 애플리케이션을 개발한다.

Excalidraw upstream repository 또는 Nib를 fork하지 않는다.

```text
Application
├── Dashboard
├── Authentication
├── Document Management
├── Sharing
├── Version History
├── Admin
└── Excalidraw Editor
    └── @excalidraw/excalidraw

```

### 데이터베이스

SQLite를 사용한다.

개인 및 소규모 self-hosted 환경을 주요 대상으로 하기 때문에 별도 DB 서버를 요구하지 않는다.

### 파일 저장소

이미지 및 첨부 파일은 SQLite 내부에 저장하지 않고 로컬 filesystem에 저장한다.

```text
/data
├── app.db
├── attachments/
└── thumbnails/

```

애플리케이션의 persistent data는 `/data` 하나로 통합한다.

---

# 3. 배포

기본 배포 단위는 Docker Compose이다.

```text
docker compose
└── app
    ├── Web Application
    ├── SQLite
    ├── Excalidraw
    └── /data volume

```

별도의 PostgreSQL, Redis, S3, OIDC Provider 등은 MVP에서 요구하지 않는다.

Reverse proxy와 HTTPS는 애플리케이션의 필수 구성 요소로 포함하지 않는다.

Caddy, Nginx, Traefik 등과 연결하는 방법은 별도 deployment example로 제공할 수 있다.

---

# 4. 인증

## 4.1 사용자 계정

애플리케이션은 자체 사용자 계정 시스템을 제공한다.

사용자는 다음 정보로 로그인한다.

```text
username
password

```

이메일은 요구하지 않는다.

공개 회원가입 기능은 제공하지 않는다.

---

## 4.2 최초 관리자

최초 관리자 계정은 환경변수로 bootstrap한다.

예:

```text
ADMIN_USERNAME
ADMIN_PASSWORD

```

애플리케이션 시작 시 관리자 계정이 존재하지 않을 경우에만 생성한다.

이미 생성된 관리자 계정의 비밀번호를 환경변수 변경으로 자동 덮어쓰지 않는다.

---

## 4.3 사용자 생성

관리자만 새로운 사용자 계정을 생성할 수 있다.

사용자가 직접 회원가입하는 기능은 제공하지 않는다.

---

## 4.4 비밀번호

사용자는 자신의 비밀번호를 변경할 수 있다.

관리자는 사용자의 비밀번호를 재설정할 수 있다.

애플리케이션 차원의 최소 길이 또는 복잡도 정책은 강제하지 않는다.

비밀번호는 반드시 secure password hash 형태로 저장한다.

평문 비밀번호는 저장하지 않는다.

---

# 5. 사용자 역할

시스템 계정 수준에서는 다음 역할을 가진다.

```text
USER
ADMIN

```

ADMIN은 일반 사용자 기능을 모두 사용할 수 있다.

---

# 6. 관리자 모드

관리자는 로그인 직후에도 기본적으로 일반 사용자와 동일한 권한 범위에서 서비스를 사용한다.

즉 일반 모드에서는:

- 자신의 문서
- 자신에게 공유된 문서

만 접근할 수 있다.

다른 사용자의 private 문서는 기본 모드에서 볼 수 없다.

관리자는 명시적으로 `Admin Mode`에 진입해야 시스템 전체 관리 권한을 사용할 수 있다.

관리자 모드 진입 시 추가 비밀번호 입력은 요구하지 않는다.

관리자 모드에서는 다음 기능을 제공한다.

- 사용자 목록 조회
- 사용자 생성
- 사용자 비활성화 또는 삭제
- 사용자 비밀번호 재설정
- 전체 문서 조회
- 임의 문서 열람
- 임의 문서 수정
- 임의 문서 삭제
- 필요 시 문서 소유권 관리

---

# 7. 문서

## 7.1 문서 생성

모든 사용자는 새로운 Excalidraw 문서를 생성할 수 있다.

문서를 생성한 사용자가 해당 문서의 OWNER가 된다.

새 문서는 항상 private 상태로 생성된다.

---

## 7.2 기본 문서 속성

문서는 최소한 다음 정보를 가진다.

```text
id
title
owner
scene
created_at
updated_at
deleted_at

```

추가적으로 다음 리소스와 연결될 수 있다.

```text
attachments
thumbnail
versions
members
share_link

```

---

# 8. 문서 권한 모델

문서 권한은 처음부터 다음 3단계로 설계한다.

```text
OWNER
EDITOR
VIEWER

```

MVP에서 EDITOR 공유 기능을 실제 UI로 노출하지 않더라도 데이터 모델과 authorization layer에서는 EDITOR를 독립 역할로 취급한다.

향후 공동 편집 기능 추가 시 DB schema 변경 없이 활성화할 수 있어야 한다.

---

## 8.1 OWNER

각 문서는 정확히 한 명의 OWNER를 가진다.

OWNER는 다음 작업을 수행할 수 있다.

- 문서 읽기
- 문서 편집
- 문서 이름 변경
- 문서 삭제
- 휴지통 복원
- 영구 삭제
- 버전 히스토리 조회
- 이전 버전 복원
- 사용자 공유 관리
- 공유 링크 생성 및 폐기
- 문서 소유권 이전

---

## 8.2 EDITOR

향후 편집 공유 및 실시간 협업을 위한 역할이다.

권한 모델과 DB schema에는 포함한다.

MVP에서는 일반 사용자가 다른 사용자에게 EDITOR 권한을 부여하는 기능은 제공하지 않는다.

향후 활성화할 수 있어야 한다.

---

## 8.3 VIEWER

VIEWER는 문서를 읽을 수 있지만 변경할 수 없다.

---

# 9. 소유권 이전

OWNER는 다른 사용자에게 문서 소유권을 이전할 수 있다.

문서에는 항상 정확히 한 명의 OWNER가 존재해야 한다.

소유권 이전은 atomic transaction으로 처리한다.

기존 OWNER는 소유권 이전 후 EDITOR 역할로 변경한다.

예:

```text
Before

alice: OWNER
bob: VIEWER

Transfer alice → bob

After

bob: OWNER
alice: EDITOR

```

---

# 10. 저장

## 10.1 자동 저장

문서가 변경되면 마지막 변경으로부터 약 3초 후 자동 저장한다.

debounce 방식으로 동작한다.

연속적인 편집 중에는 불필요한 저장 요청을 반복하지 않는다.

자동 저장은 현재 문서 상태를 갱신하지만 매번 새로운 복구 버전을 생성하지 않는다.

---

## 10.2 수동 저장

사용자는 명시적인 `Save` 기능을 사용할 수 있다.

수동 저장은 debounce 대기 여부와 관계없이 즉시 저장한다.

수동 저장 시 복구용 version snapshot을 생성한다.

---

# 11. 버전 히스토리

각 문서는 최근 20개의 복구용 snapshot을 유지한다.

자동 저장 요청마다 snapshot을 생성하지 않는다.

복구 snapshot 생성 정책:

```text
자동 편집
→ 현재 상태 auto-save
→ 마지막 snapshot 이후 5분 이상 지났다면 snapshot 생성 가능

수동 Save
→ 현재 상태 즉시 저장
→ snapshot 즉시 생성

```

최근 20개를 초과하는 오래된 snapshot은 정리한다.

사용자는 version history 화면에서 이전 상태를 확인하고 복원할 수 있어야 한다.

이전 버전을 복원하는 작업 자체도 새로운 현재 상태로 저장한다.

---

# 12. 이미지 및 첨부 파일

Excalidraw 문서에 삽입된 이미지와 기타 binary resource는 로컬 filesystem에 저장한다.

DB에는 파일의 metadata와 reference를 저장한다.

가능하면 문서별 storage namespace를 사용한다.

예:

```text
/data/attachments/
└── <document-id>/
    ├── ...
    └── ...

```

---

## 12.1 버전과 첨부 파일

현재 scene에서 이미지가 제거되었더라도 과거 version snapshot이 해당 이미지를 참조하면 실제 파일을 삭제하지 않는다.

파일은 다음 어디에서도 참조되지 않을 때만 물리적으로 제거할 수 있다.

- 현재 문서
- 보존 중인 version snapshot

따라서 이전 버전 복원 시 이미지가 깨져서는 안 된다.

---

# 13. 문서 삭제와 휴지통

문서 삭제는 기본적으로 soft delete이다.

삭제된 문서는 `Trash`로 이동한다.

자동 영구 삭제 기간은 두지 않는다.

휴지통에서 사용자는 다음 작업을 할 수 있다.

- 복원
- 영구 삭제

영구 삭제 시:

1. 현재 문서 삭제
2. version history 삭제
3. document membership 삭제
4. share link 제거
5. attachment reference 제거
6. 더 이상 참조되지 않는 실제 파일 삭제
7. thumbnail 제거

를 수행한다.

---

# 14. 대시보드

로그인 후 기본 화면은 Excalidraw editor가 아니라 Dashboard이다.

대시보드는 최소한 다음 영역을 제공한다.

```text
Dashboard
├── My Documents
├── Shared With Me
├── Trash
└── Admin Mode

```

`Admin Mode`는 관리자에게만 표시한다.

---

# 15. My Documents

자신이 OWNER인 문서를 보여준다.

문서 카드 또는 목록에는 최소한 다음 정보를 표시한다.

- 제목
- 썸네일
- 마지막 수정 시간

문서 제목 검색을 지원한다.

태그와 폴더 기능은 MVP에서 제공하지 않는다.

---

# 16. Shared With Me

다른 사용자가 현재 사용자에게 공유한 문서를 보여준다.

MVP에서는 실제 공유 권한은 VIEWER만 사용한다.

사용자는 공유받은 문서를 읽을 수 있지만 수정할 수 없다.

---

# 17. 썸네일

문서 목록을 빠르게 표시하기 위해 thumbnail을 별도 파일로 저장한다.

문서 목록 진입 시마다 Excalidraw scene을 렌더링하여 thumbnail을 생성하지 않는다.

thumbnail은 다음 시점에 갱신한다.

- 수동 저장
- 새로운 version snapshot 생성

PNG 기반 thumbnail을 기본으로 한다.

---

# 18. 사용자 지정 공유

OWNER는 특정 애플리케이션 사용자에게 문서를 공유할 수 있다.

공유 사용자 수에는 애플리케이션 레벨의 인위적인 제한을 두지 않는다.

MVP에서는 사용자에게 부여 가능한 공유 권한은 VIEWER이다.

내부 데이터 모델은 다음을 지원해야 한다.

```text
OWNER
EDITOR
VIEWER

```

---

# 19. 공유 링크

OWNER는 로그인하지 않은 사용자에게도 문서를 보여줄 수 있는 읽기 전용 share link를 생성할 수 있다.

share link를 가진 사용자는 계정 없이 문서를 볼 수 있다.

MVP의 share link는 VIEWER 권한만 제공한다.

향후 EDITOR 링크를 지원할 수 있도록 데이터 모델에서는 permission 개념을 확장 가능하게 설계한다.

---

## 19.1 공유 링크 개수

한 문서에는 활성 share link가 최대 하나만 존재한다.

---

## 19.2 공유 링크 만료

기본적으로 공유 링크에는 만료 시간이 없다.

OWNER가 원하면 만료 시간을 설정할 수 있다.

만료된 링크에 대한 접근은 거부한다.

OWNER는 언제든 공유 링크를 비활성화하거나 재생성할 수 있다.

링크를 재생성하면 이전 token은 즉시 무효화한다.

---

# 20. 읽기 전용 Viewer

공유받은 사용자 또는 anonymous share-link 사용자가 문서를 열 경우 Excalidraw를 read-only 상태로 제공한다.

Viewer 화면에서도 일반 Excalidraw의 zoom, pan 등 문서 탐색 기능은 사용할 수 있어야 한다.

문서 내용을 변경하거나 서버에 저장할 수는 없다.

---

# 21. Import / Export

표준 `.excalidraw` 파일 형식과의 호환성을 유지한다.

다음을 지원한다.

### Import

사용자가 `.excalidraw` 파일을 업로드하여 새로운 문서로 생성할 수 있다.

### Export

사용자가 자신의 문서를 `.excalidraw` 파일로 내려받을 수 있다.

가능한 경우 Excalidraw ecosystem에서 다시 열 수 있는 표준 format을 유지한다.

데이터를 서비스 내부 포맷에 lock-in하지 않는다.

---

# 22. 백업

MVP에서는 애플리케이션 자체의 backup scheduler 또는 backup management UI를 구현하지 않는다.

persistent data는 `/data` 아래에 모은다.

```text
/data
├── app.db
├── attachments/
└── thumbnails/

```

운영자는 `/data` volume 자체를 백업함으로써 전체 애플리케이션 데이터를 백업할 수 있어야 한다.

---

# 23. 실시간 협업

실시간 공동 편집은 MVP 범위에 포함하지 않는다.

현재 MVP는 다음까지만 제공한다.

```text
Document owner
        ↓
Edit

Viewer
        ↓
Read only

```

EDITOR 역할은 데이터 모델에 존재하지만 사용자에게 활성화하지 않는다.

---

# 24. 향후 협업 로드맵

## Phase 1: MVP

- 사용자 계정
- 관리자
- 문서 관리
- Excalidraw 내장
- 저장/불러오기
- 자동 저장
- 수동 저장
- 버전 히스토리
- 파일 저장
- 휴지통
- 사용자 지정 read-only 공유
- anonymous read-only link
- import/export

## Phase 2

EDITOR 권한 활성화.

다른 사용자에게 문서 편집 권한을 부여할 수 있도록 한다.

실시간 협업 없이 여러 사용자가 순차적으로 문서를 편집하는 기능부터 고려한다.

필요한 경우 optimistic concurrency control을 추가한다.

## Phase 3

Excalidraw collaboration infrastructure 또는 compatible room server를 연동하여 실시간 공동 편집을 지원한다.

다음 기능을 고려한다.

- 실시간 cursor
- multi-user scene synchronization
- collaborative editing
- conflict resolution
- presence

---

# 25. MVP에서 제외하는 기능

다음 기능은 초기 버전에서 구현하지 않는다.

- 공개 회원가입
- 이메일 인증
- 이메일 기반 password reset
- OIDC
- Google/GitHub login
- S3/R2 storage
- PostgreSQL
- Redis
- 실시간 공동 편집
- EDITOR 공유 활성화
- 태그
- 폴더
- full-text search
- 댓글
- notification
- 앱 내부 백업 UI
- 자동 휴지통 비우기
- 모바일 전용 애플리케이션

---

# 26. 초기 데이터 모델 방향

구체적인 ORM schema는 implementation plan에서 결정하지만 주요 entity는 다음과 같다.

```text
User

Document

DocumentMember

DocumentVersion

Attachment

ShareLink

Session

```

관계는 개념적으로 다음과 같다.

```text
User
 │
 │ owns
 ▼
Document
 ├── DocumentVersion
 ├── Attachment
 ├── ShareLink
 └── DocumentMember
          │
          └── User

```

---

# 27. 제품의 핵심 원칙

## Simple Self-hosting

사용자가 다음과 같은 경험으로 서비스를 시작할 수 있어야 한다.

```bash
docker compose up -d

```

## Upstream-friendly

Excalidraw를 직접 fork하지 않는다.

`@excalidraw/excalidraw`를 dependency로 사용하여 upstream 업데이트를 가능한 쉽게 따라간다.

## Private by Default

모든 문서는 private으로 생성한다.

명시적으로 공유하지 않는 한 다른 사용자는 접근할 수 없다.

## Data Ownership

사용자는 표준 `.excalidraw` export를 통해 자신의 데이터를 언제든 서비스 밖으로 가져갈 수 있다.

## Local-first Infrastructure

SQLite와 local volume을 기본 저장소로 사용하여 외부 서비스를 필수 dependency로 만들지 않는다.

## Future-proof Permissions

MVP에서 VIEWER 공유만 사용하더라도 OWNER, EDITOR, VIEWER 권한 모델을 처음부터 분리한다.

향후 공동 편집 기능을 추가할 때 데이터 모델 전체를 다시 설계하지 않는다.

---

# 28. MVP 성공 기준

다음 시나리오가 정상적으로 동작하면 MVP의 핵심 목표를 달성한 것으로 본다.

1. 관리자가 Docker Compose로 애플리케이션을 실행한다.
2. 환경변수로 최초 관리자 계정이 생성된다.
3. 관리자가 새로운 사용자 계정을 생성할 수 있다.
4. 사용자가 로그인한다.
5. Dashboard가 표시된다.
6. 사용자가 새로운 Excalidraw 문서를 만든다.
7. 브라우저에서 Excalidraw를 정상적으로 사용할 수 있다.
8. 변경 내용이 자동 저장된다.
9. 사용자가 Save를 눌러 명시적으로 저장할 수 있다.
10. 로그아웃 후 다시 로그인해도 문서를 다시 열 수 있다.
11. 이전 version snapshot으로 문서를 복원할 수 있다.
12. 이미지가 포함된 문서도 정상적으로 저장/복원된다.
13. 삭제한 문서는 Trash에서 복원할 수 있다.
14. 사용자가 다른 계정에 VIEWER 권한으로 문서를 공유할 수 있다.
15. 공유받은 사용자는 문서를 읽을 수 있지만 수정할 수 없다.
16. OWNER가 anonymous read-only share link를 만들 수 있다.
17. 링크만 가진 사용자가 로그인 없이 문서를 볼 수 있다.
18. `.excalidraw` import/export가 정상적으로 동작한다.
19. `/data`를 보존하고 컨테이너를 재생성해도 모든 데이터가 유지된다.
20. 관리자가 Admin Mode에서 전체 사용자와 문서를 관리할 수 있다.

