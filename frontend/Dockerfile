FROM node:18-alpine

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --silent

# Copy source
COPY . .

# Build static assets
RUN npm run build

EXPOSE 5173

# Use vite preview to serve built assets
CMD ["npm", "run", "preview", "--", "--host", "0.0.0.0", "--port", "5173"]
