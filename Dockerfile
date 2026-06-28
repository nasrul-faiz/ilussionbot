FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./

RUN npm config set registry https://registry.npmjs.org && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    npm config set fetch-retries 5 && \
    npm install --legacy-peer-deps

COPY . .

RUN mkdir -p data session public/uploads temp tmp

ENV PORT=5000
EXPOSE 5000

CMD ["bash", "start.sh"]
