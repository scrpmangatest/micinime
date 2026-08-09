#!/bin/bash
cd /home/rclffqwl/micinime
source /home/rclffqwl/nodevenv/micinime/24/bin/activate

if ! pgrep -f "node server.js" > /dev/null 2>&1; then
  nohup node server.js > /dev/null 2>&1 &
  echo "[$(date)] server restarted" >> data/healthcheck.log
fi
