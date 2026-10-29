# Home Assistant builds this when you install the add-on. It uses the official
# Node.js image (Home Assistant's own base image isn't needed for this server).
FROM node:22-alpine

WORKDIR /app
COPY app/package.json app/package-lock.json ./
# The database library is compiled for this machine's processor, then the
# compiler tools are removed again to keep the add-on small.
RUN apk add --no-cache --virtual .build-tools python3 make g++ \
 && npm ci --omit=dev \
 && apk del .build-tools
COPY app/src ./src

ENV DATA_DIR=/data NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/index.js"]
