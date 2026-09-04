FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy application files
COPY . .

# Expose port for cloud server
EXPOSE 5000

# Default command (can be overridden)
CMD ["node", "remote-cloud-server.js"]
