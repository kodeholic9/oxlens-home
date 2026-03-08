# SFU Benchmark Guide

> `livechat-bench` — light-livechat SFU 서버의 fan-out 처리량 및 지연시간 측정 도구

## 빌드

```bash
cd livechat-bench
cargo build --release
```

릴리즈 빌드 권장. 디버그 빌드는 SRTP encrypt/decrypt 오버헤드가 크다.

## 사전 조건

- light-livechat 서버가 실행 중이어야 한다
- 서버 `.env`에 `PUBLIC_IP=127.0.0.1` (로컬 테스트 시)

## 실행

```bash
sfu-bench --server <IP> --ws-port <PORT> --udp-port <PORT> [OPTIONS]
```

### 옵션

| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `--server` | 127.0.0.1 | SFU 서버 IP |
| `--ws-port` | 19741 | WebSocket 시그널링 포트 |
| `--udp-port` | 19740 | UDP 미디어 포트 |
| `--publishers` | 1 | Publisher 수 (현재 1 고정) |
| `--subscribers` | 0 | Subscriber 수 (0이면 publisher만 테스트) |
| `--duration` | 30 | 테스트 시간 (초) |
| `--fps` | 30 | 초당 RTP 패킷 전송 횟수 |
| `--pkt-size` | 1200 | RTP 패킷 크기 (bytes) |
| `--room` | bench | 벤치마크 방 이름 |
| `--label` | baseline | 리포트 라벨 (before/after 비교용) |

### 동작 흐름

```
1. Publisher: WS 시그널링 (IDENTIFY → ROOM_CREATE → ROOM_JOIN)
2. Publisher: STUN → DTLS active handshake → SRTP key 설치
3. Subscriber ×N: WS 시그널링 (IDENTIFY → ROOM_JOIN)
4. Subscriber ×N: STUN → DTLS active handshake → SRTP key 설치
5. Publisher: PUBLISH_TRACKS (video SSRC 등록)
6. Publisher: fake RTP 전송 (fps × pkt-size, duration 동안)
7. Subscriber: SRTP decrypt + seq gap loss 감지 + latency 측정
8. 리포트 출력
```

## 예시

### Publisher만 (서버 RTP 수신 확인용)

```bash
sfu-bench --server 127.0.0.1 --ws-port 1974 --udp-port 19740 \
          --duration 10 --fps 30
```

### Fan-out 4 (subscriber 4명)

```bash
sfu-bench --server 127.0.0.1 --ws-port 1974 --udp-port 19740 \
          --subscribers 4 --duration 30 --fps 30 --label fan-out-4
```

### Fan-out 10 (대규모 테스트)

```bash
sfu-bench --server 127.0.0.1 --ws-port 1974 --udp-port 19740 \
          --subscribers 10 --duration 60 --fps 30 --pkt-size 1200 --label fan-out-10
```

### 라즈베리파이 원격 서버

```bash
sfu-bench --server 192.168.0.10 --ws-port 1974 --udp-port 19740 \
          --subscribers 4 --duration 30 --label rpi-baseline
```

## 리포트 예시

```
╔══════════════════════════════════════════════════════════╗
║            LIGHT-SFU BENCHMARK REPORT                   ║
╚══════════════════════════════════════════════════════════╝

  label:         fan-out-4
  server:        127.0.0.1:19740
  config:        1 pub → 4 sub (fan-out=4), 30fps, 1200B
  duration:      30.0s

  ── Publisher Throughput ──
  tx_packets:    901
  tx_bytes:      1090210 (1.04 MB)
  tx_pps:        30.0 pps
  tx_throughput: 0.29 Mbps

  ── Fan-out Aggregate ──
  rx_total:      3600 pkts (4.15 MB)
  rx_pps:        119.9 pps (4×30.0 expected)
  rx_throughput: 1.16 Mbps
  lost:          0 (0.000%)

  ── End-to-End Latency ──
  avg:           4945 µs (4.95 ms)
  p95:           8398 µs (8.40 ms)
  max:           110311 µs (110.31 ms)

  ── Per-Subscriber Detail ──
  [S001] rx=900 lost=0 avg=6119µs p95=8398µs max=110311µs
  [S002] rx=900 lost=0 avg=3680µs p95=4679µs max=93277µs
  [S003] rx=900 lost=0 avg=5415µs p95=7116µs max=108875µs
  [S004] rx=900 lost=0 avg=4568µs p95=5951µs max=106067µs
```

## 측정 지표

| 지표 | 설명 |
|------|------|
| tx_pps | Publisher 초당 전송 패킷 수 |
| tx_throughput | Publisher 전송 대역폭 (Mbps) |
| rx_total | Subscriber 전체 수신 패킷 (= tx × fan-out 이면 정상) |
| rx_pps | Subscriber 전체 초당 수신 패킷 |
| lost | seq gap 기반 손실 감지 |
| loss_rate | 손실률 (%) |
| latency avg/p95/max | RTP payload에 삽입한 send timestamp 기반 E2E 지연 (µs) |

## Conference 모드 (회의실 시뮬레이션)

N명이 모두 publish + subscribe. 총 N×(N-1) 스트림.

```bash
# 5인 회의 (20 스트림)
sfu-bench --mode conference --participants 5 --duration 60 --fps 30 \
          --server 192.168.0.29 --ws-port 1974 --udp-port 19740 --label conf-5p

# 10인 회의 (90 스트림)
sfu-bench --mode conference --participants 10 --duration 60 --fps 30 \
          --server 192.168.0.29 --ws-port 1974 --udp-port 19740 --label conf-10p

# 20인 회의 (380 스트림)
sfu-bench --mode conference --participants 20 --duration 60 --fps 30 \
          --server 192.168.0.29 --ws-port 1974 --udp-port 19740 --label conf-20p
```

### Conference 리포트 예시

```
╔══════════════════════════════════════════════════════════╗
║      LIGHT-SFU BENCHMARK REPORT (conference)            ║
╚══════════════════════════════════════════════════════════╝

  participants:  10
  streams:       90 (10×9)
  input_pps:     300.0 (10×30fps)
  output_pps:    2700.0 (90×30fps)
  lost:          0 (0.000%)
  avg latency:   6.2 ms

  ── Per-Participant Detail ──
  [P001] tx=900 rx=8100/8100 lost=0 from=9 avg=6102µs p95=... ✓
  [P002] tx=900 rx=8100/8100 lost=0 from=9 avg=6305µs p95=... ✓
  ...
```

### Fan-out vs Conference 차이

| | Fan-out | Conference |
|---|---|---|
| 구조 | 1 pub → N sub | N pub+sub |
| 입력 | 30 pps | N×30 pps |
| 출력 | N×30 pps | N×(N-1)×30 pps |
| decrypt | 1회/프레임 | N회/프레임 |
| encrypt | N회/프레임 | N×(N-1)회/프레임 |

## TWCC 전후 비교 시나리오

```bash
# 1. REMB baseline 측정
sfu-bench --subscribers 4 --duration 60 --label baseline-remb \
          --server 127.0.0.1 --ws-port 1974 --udp-port 19740

# 2. 서버에 TWCC 적용 후 재시작

# 3. TWCC 측정
sfu-bench --subscribers 4 --duration 60 --label twcc-v1 \
          --server 127.0.0.1 --ws-port 1974 --udp-port 19740

# 4. 두 리포트의 latency/loss/throughput 비교
```

## 주의사항

- 로컬 PC에서 subscriber 수를 과도하게 늘리면 CPU 경합으로 latency가 왜곡된다
- latency는 단일 머신 기준 (clock skew 없음). 원격 서버 테스트 시에는 NTP 동기화 오차 감안
- 서버 `.env`의 `LOG_LEVEL=debug` 시 hot-path 로그가 성능에 영향을 줄 수 있으므로 벤치 시에는 `LOG_LEVEL=info` 권장
- 서버 어드민 대시보드(`/admin/ws`)를 함께 열면 `server_metrics`로 relay/encrypt/decrypt 타이밍도 확인 가능
