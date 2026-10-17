#!/bin/sh
# 容器入口：Xvfb 虚拟显示 + socat（headful Chromium 的 CDP 只绑 127.0.0.1，转发到 0.0.0.0）
# docker start 重入时上次的 X 锁残留会让 Xvfb 拒启（Server is already active）——先清锁
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
Xvfb :99 -screen 0 1280x900x24 &
export DISPLAY=:99
socat TCP-LISTEN:9223,fork,bind=0.0.0.0 TCP:127.0.0.1:9222 &
sleep 1
exec /usr/local/bin/kernel \
  --no-sandbox --disable-dev-shm-usage \
  --use-angle=swiftshader-webgl --enable-unsafe-swiftshader \
  --no-first-run --no-default-browser-check \
  --remote-debugging-port=9222 \
  "$@"
