#!/usr/bin/env bash
# demo-activity.sh — publishes realistic MQTT events to populate the supervisor dashboard
# Requires: mosquitto-clients, MQTT broker on localhost
# Projects must exist as directories under ~/projects to pass the server's isOwnProject filter.

set -euo pipefail
HOST="${SUPERVISOR_MQTT_HOST:-localhost}"
pub() { mosquitto_pub -h "$HOST" -t "$1" -m "$2"; }

echo "Publishing demo activity to supervisor dashboard (~30s)..."

# gpu-monitor: sensor polling refactor
pub "supervisor/gpu-monitor/sensor-refactor/status"    '{"status":"started","description":"Refactoring RTX 5070 sensor polling loop"}'
sleep 1
pub "supervisor/gpu-monitor/sensor-refactor/progress"  '{"percent":30,"message":"Mapped 14 sensor endpoints, 3 are duplicated"}'
sleep 1.5
pub "supervisor/gpu-monitor/sensor-refactor/discovery" '{"finding":"GPU memory clock polled at 100ms but UI only refreshes every 2s — wasteful"}'
sleep 1
pub "supervisor/gpu-monitor/sensor-refactor/progress"  '{"percent":70,"message":"Consolidated intervals, rewriting dispatcher"}'
sleep 2

# hvac: PID tuning
pub "supervisor/hvac/pid-tuner/status"    '{"status":"started","description":"Investigating heating overshoot on zone 2"}'
sleep 0.8
pub "supervisor/hvac/pid-tuner/discovery" '{"finding":"Zone 2 Kp=1.8 causes 3.2°C overshoot — recommend Kp=0.9, Ki=0.05"}'
sleep 1.2
pub "supervisor/hvac/pid-tuner/progress"  '{"percent":60,"message":"Running simulated step-response with new PID values"}'
sleep 1.5
pub "supervisor/hvac/pid-tuner/progress"  '{"percent":100,"message":"PID values validated, updating config"}'
sleep 0.8
pub "supervisor/hvac/pid-tuner/status"    '{"status":"completed","description":"Zone 2 PID tuned — overshoot reduced to 0.4°C"}'
sleep 1

# animal-detector: model benchmark
pub "supervisor/animal-detector/bench-yolo/status"    '{"status":"started","description":"Benchmarking YOLOv8n vs YOLOv8s on Frigate clips"}'
sleep 0.8
pub "supervisor/animal-detector/bench-yolo/progress"  '{"percent":40,"message":"YOLOv8n baseline: 28ms/frame on 720p clips"}'
sleep 1.2
pub "supervisor/animal-detector/bench-yolo/discovery" '{"finding":"YOLOv8s hits 94.1% mAP vs 88.3% for YOLOv8n — worth the 2x inference cost"}'
sleep 1
pub "supervisor/animal-detector/bench-yolo/progress"  '{"percent":80,"message":"Cross-validating on night-vision clips with IR artifacts"}'
sleep 1.5
pub "supervisor/animal-detector/bench-yolo/status"    '{"status":"completed","description":"Benchmark done — YOLOv8s recommended for production"}'
sleep 0.8

# infra-deploy: schema drift (left pending for approval screenshot)
pub "supervisor/infra-deploy/schema-drift/status"    '{"status":"started","description":"Checking schema drift between staging and prod"}'
sleep 0.8
pub "supervisor/infra-deploy/schema-drift/discovery" '{"finding":"Found 3 unused API endpoints still in prod route table — safe to prune"}'
sleep 1
pub "supervisor/infra-deploy/schema-drift/discovery" '{"finding":"DB query for pool member stats takes 4.2s — missing index on device_id"}'
sleep 1.2
pub "supervisor/infra-deploy/schema-drift/progress"  '{"percent":90,"message":"Migration patch generated, awaiting approval before applying to prod"}'
sleep 1
pub "supervisor/infra-deploy/schema-drift/coordination" '{"message":"NEEDS REVIEW: /tmp/schema-drift.sql ready — requires human approval before prod DB apply"}'
sleep 1

# agent chat between gpu-monitor agents
mosquitto_pub -h "$HOST" -r -t "supervisor/gpu-monitor/chat/sensor-review/messages/1" \
    -m '{"from":"sensor-refactor","seq":1,"msg":"PROPOSAL: Drop polling to 500ms and cache in-process ring buffer"}'
mosquitto_pub -h "$HOST" -r -t "supervisor/gpu-monitor/chat/sensor-review/seq" -m "1"
sleep 1.5
mosquitto_pub -h "$HOST" -r -t "supervisor/gpu-monitor/chat/sensor-review/messages/2" \
    -m '{"from":"arch-reviewer","seq":2,"msg":"COUNTER: Ring buffer is fine but cap at 256 samples — agree on 500ms"}'
mosquitto_pub -h "$HOST" -r -t "supervisor/gpu-monitor/chat/sensor-review/seq" -m "2"
sleep 1

pub "supervisor/gpu-monitor/sensor-refactor/status" '{"status":"completed","description":"Sensor polling refactored — CPU usage down 18%"}'

echo "Done. Dashboard populated with activity from 4 projects."
