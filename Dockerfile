FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG GIT_SHA=local
# DEPLOY_ENV stays a placeholder here; docker/40-inject-deploy-env.sh fills it in at container start.
RUN DEPLOY_ENV=__DEPLOY_ENV__ GITHUB_SHA=$GIT_SHA npm run build

FROM nginx:1.27-alpine
RUN apk update && apk upgrade --no-cache
COPY --from=build /app/dist /usr/share/nginx/html
COPY --chmod=755 docker/40-inject-deploy-env.sh /docker-entrypoint.d/
EXPOSE 80
