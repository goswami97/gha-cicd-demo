#!/bin/sh
# The same image is promoted development -> qa -> production, so the environment
# name can't be baked in at build time. nginx runs every script in
# /docker-entrypoint.d/ before starting; DEPLOY_ENV comes from the k8s Deployment.
set -eu
sed -i "s|__DEPLOY_ENV__|${DEPLOY_ENV:-unknown}|g" /usr/share/nginx/html/index.html
