#!/bin/bash

checkProcAlive() {
  local procname=$1
  if ps aux | grep "$procname" | grep -v "grep" >/dev/null; then
    return 0
  else
    return 1
  fi
}
username=$(whoami)

if ! checkProcAlive index.js ; then
   echo "check" >> /home/$username/a.log
   cd /home/$username/public_html 
   if [ -e "node_modules" ]; then
     nohup /opt/alt/alt-nodejs20/root/usr/bin/node index.js > out.log 2>&1 &
   fi
fi
