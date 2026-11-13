FROM node:22-alpine AS build

WORKDIR /app/web

COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY shared/ /app/shared/
COPY web/ ./
RUN npm run build

FROM nginx:alpine

COPY containers/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist/better-mindmap/browser /usr/share/nginx/html

EXPOSE 80
