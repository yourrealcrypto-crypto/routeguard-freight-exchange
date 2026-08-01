FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --include=dev --ignore-scripts

COPY . .
RUN npm run build && chown -R node:node /app

USER node
EXPOSE 3000
CMD ["npm", "run", "start"]
