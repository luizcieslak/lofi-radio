# Docker & Docker Compose Deployment

This guide covers deploying lofi-radio using Docker or Docker Compose for local development or self-hosted servers.

**Note:** This guide uses volume mounts for easy song management. For Railway deployment, see [Railway guide](railway.md) which uses a different approach.

## Quick Start with Docker Compose (Recommended)

### 1. Add Your Songs

```bash
# Place your MP3 files in the songs/ folder
mkdir -p songs
cp /path/to/your/music/*.mp3 songs/
```

### 2. Start the Server

```bash
docker-compose up -d
```

That's it! Your radio is now streaming at `http://localhost:5634`

### 3. View Logs

```bash
docker-compose logs -f
```

### 4. Stop the Server

```bash
docker-compose down
```

## Configuration

### Environment Variables

Create a `.env` file in the project root:

```bash
PORT=5634
```

The `docker-compose.yml` will automatically read this file.

### Custom Port

```bash
# Option 1: Edit .env file
echo "PORT=8080" > .env

# Option 2: Inline override
PORT=8080 docker-compose up -d
```

### Volume Mounts

The `docker-compose.yml` mounts two local directories:

- `./songs` → `/app/songs` - Your MP3 library
- `./src/state` → `/app/src/state` - Playlist state persistence

**This means:**
- ✅ Songs are read from your local filesystem
- ✅ State persists across container restarts
- ✅ Easy to add/remove songs (just edit `./songs` folder and restart)

## Standalone Docker (Without Compose)

### Build Image

```bash
docker build -t lofi-radio .
```

### Run Container

```bash
docker run -d \
  --name lofi-radio \
  -p 5634:5634 \
  -v $(pwd)/songs:/app/songs \
  -v $(pwd)/src/state:/app/src/state \
  lofi-radio
```

### Stop Container

```bash
docker stop lofi-radio
docker rm lofi-radio
```

## Production Deployment (VPS/Server)

### Option 1: Docker Compose on VPS

```bash
# 1. SSH to your server
ssh user@your-server.com

# 2. Clone repo
git clone https://github.com/your-username/lofi-radio.git
cd lofi-radio

# 3. Add songs
scp -r ./local-songs/* user@your-server.com:~/lofi-radio/songs/

# 4. Start
docker-compose up -d

# 5. Set up reverse proxy (nginx/caddy)
# See nginx.conf example below
```

### Option 2: Run Without Docker

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash

# Install dependencies
bun install

# Add songs
cp /path/to/songs/*.mp3 songs/

# Start server
PORT=5634 bun run src/server.ts
```

**For production, use a process manager:**

```bash
# Option A: PM2
npm install -g pm2
pm2 start src/server.ts --interpreter bun --name lofi-radio

# Option B: systemd service (see systemd.md)
```

## Reverse Proxy Setup

### Nginx

```nginx
server {
    listen 80;
    server_name radio.yourdomain.com;

    location / {
        proxy_pass http://localhost:5634;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;

        # Important for SSE (Server-Sent Events)
        proxy_buffering off;
        proxy_read_timeout 86400;
    }
}
```

### Caddy

```caddy
radio.yourdomain.com {
    reverse_proxy localhost:5634
}
```

## Updating Songs

### Add Songs

```bash
# Copy new songs to folder
cp new-song.mp3 songs/

# Restart container to pick up changes
docker-compose restart
```

### Replace All Songs

```bash
# Clear old songs
rm -rf songs/*

# Add new songs
cp /path/to/new/songs/*.mp3 songs/

# Restart
docker-compose restart
```

## Troubleshooting

### "No tracks available"

**Check if songs folder is empty:**

```bash
docker-compose exec lofi-radio ls -la /app/songs
```

**Fix:** Add MP3 files to `./songs` folder and restart.

### Port Already in Use

```bash
# Check what's using port 5634
lsof -ti:5634

# Kill the process
lsof -ti:5634 | xargs kill

# Or use a different port
PORT=8080 docker-compose up -d
```

### Container Won't Start

```bash
# Check logs
docker-compose logs

# Rebuild image (if Dockerfile changed)
docker-compose build --no-cache
docker-compose up -d
```

### Permission Issues (Linux)

```bash
# Fix folder permissions
sudo chown -R $USER:$USER songs/ src/state/

# Or run container with your user ID
docker run -u $(id -u):$(id -g) ...
```

## Health Checks

The `docker-compose.yml` includes a health check that pings `/status` every 30 seconds.

**Check health status:**

```bash
docker ps
# Look for "healthy" in STATUS column
```

**Manual health check:**

```bash
curl http://localhost:5634/status
```

## Backup & Restore

### Backup Songs & State

```bash
# Backup
tar -czf lofi-radio-backup.tar.gz songs/ src/state/

# Restore
tar -xzf lofi-radio-backup.tar.gz
docker-compose restart
```

### Export Image

```bash
# Save image
docker save lofi-radio:latest | gzip > lofi-radio-image.tar.gz

# Load on another machine
docker load < lofi-radio-image.tar.gz
```

## Performance Tuning

### Resource Limits (Docker Compose)

Add to `docker-compose.yml`:

```yaml
services:
  lofi-radio:
    # ... existing config
    deploy:
      resources:
        limits:
          cpus: '0.5'
          memory: 512M
        reservations:
          cpus: '0.25'
          memory: 256M
```

### For High Traffic

```bash
# Use multiple instances behind load balancer
# Note: All instances MUST stream from same source for sync
# This requires architectural changes (not currently supported)
```

## Cost Comparison

| Platform        | Cost/Month | Effort | Best For           |
|-----------------|------------|--------|--------------------|
| Local Docker    | $0         | Low    | Development/home   |
| VPS (DigitalOcean) | $6+     | Medium | Self-hosted       |
| Railway         | $20-30     | Low    | Quick cloud deploy |
| AWS/GCP         | $10-50     | High   | Enterprise scale   |

## Next Steps

- **Custom domain?** Set up nginx/caddy reverse proxy
- **HTTPS?** Use Let's Encrypt with certbot
- **Monitoring?** Add Prometheus/Grafana
- **Auto-updates?** Set up CI/CD with watchtower

## Resources

- [Docker Documentation](https://docs.docker.com/)
- [Docker Compose Documentation](https://docs.docker.com/compose/)
- [Nginx Reverse Proxy Guide](https://docs.nginx.com/nginx/admin-guide/web-server/reverse-proxy/)
