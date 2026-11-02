# API + 웹 빌드를 한 이미지로 묶는다 (API 가 웹 정적 파일도 서빙: SERVE_WEB=true)
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY apps ./apps
RUN npm run build

FROM node:22-slim
ENV NODE_ENV=production SERVE_WEB=true
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev -w apps/api
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/migrations apps/api/migrations
COPY --from=build /app/apps/web/dist apps/web/dist
USER node
EXPOSE 4000
CMD ["node", "apps/api/dist/index.js"]
