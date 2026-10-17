FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir /data && chown node:node /data
COPY --chown=node:node . .
ENV NODE_ENV=production
USER node
EXPOSE 3457
CMD ["node", "server.js", "--no-stdio"]
