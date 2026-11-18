# Cloud Run (or any container host): `gcloud run deploy --source .` builds this
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
# .npmrc omits devDependencies; tsx (the runtime) is a regular dependency
RUN npm ci
COPY . .
ENV NODE_ENV=production
CMD ["npm", "start"]
