#!/bin/bash
# deploy-oxlens.sh — oxlens 정적 파일 배포 스크립트
# author: kodeholic (powered by Claude & reviewed by Gemini)
#
# 사용법:
#   ./deploy-oxlens.sh patch   — git pull → nginx 배포
#   ./deploy-oxlens.sh status  — 현재 배포 상태 확인

set -euo pipefail

# --- 설정 변수 ---
BASE_DIR="$HOME"
SRC_DIR="${BASE_DIR}/src"
DEPLOY_DIR="/var/www/html/"
BACKUP_DIR="${BASE_DIR}/backup"

GIT_REPO_URL="https://github.com/kodeholic9/oxlens-home.git"
GIT_BRANCH="main"

# 배포 대상 (정적 파일만)
DEPLOY_TARGETS=(
    "index.html"
    "core"
    "client"
    "admin"
    "docs"
)

# --- 컬러 출력 ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()   { echo -e "${RED}[ERROR]${NC} $1"; }

# --- 명령 함수 ---

do_patch() {
    echo "========================================"
    echo " oxlens 배포"
    echo "========================================"

    # 1. 디렉토리 확인
    mkdir -p "$BACKUP_DIR"

    # 2. Git clone or pull
    if [ -d "${SRC_DIR}/.git" ]; then
        info "소스 업데이트 (git pull)..."
        # [수정됨] cd 대신 git -C 옵션 사용
        git -C "$SRC_DIR" fetch origin
        git -C "$SRC_DIR" checkout "$GIT_BRANCH"
        git -C "$SRC_DIR" reset --hard "origin/${GIT_BRANCH}"
    else
        info "소스 클론: ${GIT_REPO_URL} (${GIT_BRANCH})..."
        rm -rf "$SRC_DIR"
        git clone --single-branch --branch "$GIT_BRANCH" "$GIT_REPO_URL" "$SRC_DIR"
    fi
    # [수정됨] git -C 옵션 사용
    ok "소스 준비 완료 ($(git -C "$SRC_DIR" log --oneline -1))"

    # 3. 기존 배포 백업
    if [ -d "$DEPLOY_DIR" ] && [ "$(ls -A "$DEPLOY_DIR" 2>/dev/null)" ]; then
        local TIMESTAMP
        TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
        local BACKUP_FILE="${BACKUP_DIR}/oxlens_${TIMESTAMP}.tar.gz"
        info "기존 배포 백업..."
        # [수정됨] 권한 문제 방지를 위해 sudo로 압축하고 소유권은 현재 사용자로 변경
        sudo tar -czf "$BACKUP_FILE" -C "$DEPLOY_DIR" .
        sudo chown "$USER":"$USER" "$BACKUP_FILE"
        ok "백업: ${BACKUP_FILE}"

        # 오래된 백업 정리 (최근 5개 유지)
        ls -1t "${BACKUP_DIR}"/oxlens_*.tar.gz 2>/dev/null | tail -n +6 | xargs rm -f 2>/dev/null || true
    fi

    # 4. 배포
    info "배포 → ${DEPLOY_DIR}"
    sudo mkdir -p "$DEPLOY_DIR"

    for target in "${DEPLOY_TARGETS[@]}"; do
        local src="${SRC_DIR}/${target}"
        local dst="${DEPLOY_DIR}/${target}"

        if [ ! -e "$src" ]; then
            warn "  ${target} 없음 — 스킵"
            continue
        fi

        # 디렉토리면 rsync, 파일이면 cp
        if [ -d "$src" ]; then
            sudo rsync -a --delete "$src/" "$dst/"
        else
            sudo cp "$src" "$dst"
        fi
        ok "  ${target}"
    done

    # 5. deprecated 정리 (common/ → core/ 전환 잔여물)
    if [ -d "${DEPLOY_DIR}/common" ]; then
        sudo rm -rf "${DEPLOY_DIR}/common"
        info "  common/ 제거 (core/로 전환됨)"
    fi

    # 6. 권한 설정
    info "권한 및 소유권 설정 중..."
    sudo chown -R www-data:www-data "$DEPLOY_DIR"
    # [수정됨] 디렉토리는 755, 파일은 644로 분리하여 권한 부여
    sudo find "$DEPLOY_DIR" -type d -exec chmod 755 {} \;
    sudo find "$DEPLOY_DIR" -type f -exec chmod 644 {} \;

    echo "========================================"
    ok "배포 완료!"
    echo "  포탈:  http://<host>/"
    echo "  PTT:   http://<host>/client/"
    echo "  Admin: http://<host>/admin/"
    echo "  Docs:  http://<host>/docs/"
    echo "========================================"
}

do_status() {
    echo "========================================"
    echo " oxlens 배포 상태"
    echo "========================================"

    # 소스
    if [ -d "${SRC_DIR}/.git" ]; then
        # [수정됨] git -C 옵션 사용
        ok "소스: $(git -C "$SRC_DIR" log --oneline -1)"
    else
        warn "소스 없음 (patch 실행 필요)"
    fi

    # 배포 디렉토리
    if [ -d "$DEPLOY_DIR" ]; then
        ok "배포: ${DEPLOY_DIR}"
        echo ""
        for target in "${DEPLOY_TARGETS[@]}"; do
            if [ -e "${DEPLOY_DIR}/${target}" ]; then
                if [ -d "${DEPLOY_DIR}/${target}" ]; then
                    local count
                    count=$(find "${DEPLOY_DIR}/${target}" -type f | wc -l)
                    echo "  [DIR]  ${target} (${count} files)"
                else
                    echo "  [FILE] ${target} ($(du -h "${DEPLOY_DIR}/${target}" | cut -f1))"
                fi
            else
                echo "  [MISS] ${target}"
            fi
        done
    else
        warn "배포 디렉토리 없음: ${DEPLOY_DIR}"
    fi

    # 백업
    echo ""
    local backup_count
    backup_count=$(ls -1 "${BACKUP_DIR}"/oxlens_*.tar.gz 2>/dev/null | wc -l)
    info "백업: ${backup_count}개"
    ls -1t "${BACKUP_DIR}"/oxlens_*.tar.gz 2>/dev/null | head -3 | while read -r f; do
        echo "  $(basename "$f")  $(du -h "$f" | cut -f1)"
    done
}

# --- 명령 디스패치 ---
COMMAND=${1:-""}

case "$COMMAND" in
    patch)  do_patch  ;;
    status) do_status ;;
    *)
        echo "사용법: $0 [patch|status]"
        echo ""
        echo "  patch   git pull → 백업 → nginx 배포"
        echo "  status  현재 배포 상태 확인"
        exit 1
        ;;
esac