FROM node:26-bookworm
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
CMD ["node", "server.js"]