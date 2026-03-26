# Railway Deployment Guide

## Prerequisites

1. **Install Railway CLI:**
   ```bash
   npm i -g @railway/cli
   ```

2. **Login to Railway:**
   ```bash
   railway login
   ```

## Deployment Method: Docker Image with Songs

lofi-radio uses a **Docker image approach** where your songs are included in the container image. This is the simplest and most reliable method for Railway deployment.

### Why This Approach?

- ✅ **Simple:** Just deploy, no file uploads needed
- ✅ **Reliable:** Songs are part of the image, always available
- ✅ **Fast deploys:** Railway optimizes Docker layer caching
- ✅ **Works with GitHub:** Auto-deploys on push
- ⚠️ **Tradeoff:** ~5-10s downtime when updating songs (rebuild required)

**Note:** Railway SSH does not support file piping/uploads, so volume-based approaches don't work reliably.

## Initial Setup

### 1. Prepare Your Songs

```bash
# Add your MP3 files to the songs folder
mkdir -p songs
cp /path/to/your/music/*.mp3 songs/

# Verify songs are added
ls -lh songs/
```

**Important:** Songs are gitignored (won't go to GitHub) but will be included in the Docker build.

### 2. Create Railway Project

```bash
# Initialize new project
railway init

# Or link to existing project
railway link
```

### 3. Deploy

**Option A: Deploy from Local (First Time)**

```bash
railway up
```

This builds your Docker image (including songs) and deploys to Railway.

**Option B: Deploy from GitHub (Recommended for Production)**

```bash
# Connect Railway to your GitHub repo in the dashboard:
# Railway Dashboard → Settings → Connect Repo

# Then just push to deploy
git push origin main
# Railway auto-deploys
```

### 4. Access Your Radio

```bash
# Open in browser
railway open

# Or get the URL
railway domain
```

## Updating Songs

### Add or Remove Songs

```bash
# 1. Update your local songs folder
cp new-song.mp3 songs/
rm songs/old-song.mp3

# 2. Redeploy
railway up

# Or if using GitHub:
git add songs/
git commit -m "Update playlist"
git push origin main
```

**Downtime:** ~5-10 seconds during deployment switchover. Railway does:
1. Builds new image with updated songs
2. Starts new container
3. Health checks pass
4. Routes traffic to new container
5. Shuts down old container

Active listeners will be disconnected briefly and need to reconnect.

## Configuration

### Environment Variables

Railway automatically provides:
- `PORT` - Your app already reads this via `process.env.PORT`

**No additional configuration needed!**

### Custom Domain

```bash
# Add custom domain in Railway dashboard
# Settings → Domains → Add Domain
```

## Monitoring

### View Logs

```bash
railway logs

# Follow logs in real-time
railway logs --follow
```

### Check Status

```bash
railway status
```

### Check Build Progress

```bash
# During deployment
railway logs --deployment
```

## Troubleshooting

### "No tracks available"

**Cause:** Songs folder is empty or wasn't included in build

**Fix:**
```bash
# Check .dockerignore doesn't exclude songs/
cat .dockerignore | grep songs

# Should NOT see "songs/*" - if you do, remove it
```

### Build Timeout

**Cause:** Songs library too large (>2GB)

**Fix:** Consider using external storage (S3/CDN) for very large libraries

### Port Binding Issues

**Cause:** App not reading Railway's `PORT` env var

**Fix:** Already handled! `src/server.ts` reads `process.env.PORT || 5634`

### Slow Builds

**Cause:** Large songs folder or no layer caching

**Optimization:**
- Railway caches Docker layers, but songs changes force rebuild
- Keep song updates infrequent
- Consider grouping multiple song changes into one deploy

## Cost Estimation

**Railway Pricing (as of 2024):**

- **Hobby Plan:** $5/month credit
- **Compute:** ~$0.000463/min
- **Bandwidth:** First 100GB free

**Estimate for 24/7 streaming:**
- Compute: ~$20/month
- 10 concurrent listeners @ 128kbps = ~500GB/month bandwidth
- **Total: ~$20-30/month**

For lower traffic, the $5/month free credit may be sufficient!

## Advanced: Zero-Downtime Updates

If 5-10s downtime is unacceptable, you can implement an HTTP upload endpoint:

### Option 1: Add Upload API

```typescript
// In src/server.ts
import multer from 'multer'

const upload = multer({ dest: '/app/songs' })

app.post('/admin/upload-song', upload.single('file'), (req, res) => {
  playlistManager.rescan()
  res.json({ success: true })
})
```

Then upload without rebuilding:
```bash
curl -F "file=@new-song.mp3" https://your-app.railway.app/admin/upload-song
```

**Pros:** Zero downtime, no rebuild
**Cons:** Requires code changes, needs authentication

### Option 2: Use Railway Volume

1. Create volume in Railway dashboard (`/app/songs`)
2. Initial upload via upload API above
3. Songs persist across deploys
4. Update via API without rebuilding

**Note:** If using volume, remove songs from Docker image to avoid conflicts.

## Workflow Comparison

| Method | Downtime | Complexity | Best For |
|--------|----------|-----------|----------|
| Docker Image (current) | 5-10s | Low | Most use cases |
| HTTP Upload API | None | Medium | Frequent updates |
| Railway Volume + API | None | High | Large libraries |

## Next Steps

1. ✅ Deploy: `railway up`
2. ✅ Test: `railway open`
3. ✅ Monitor: `railway logs --follow`
4. ✅ Custom domain (optional)
5. ✅ Set up GitHub auto-deploy (recommended)

## Resources

- [Railway Docs](https://docs.railway.app/)
- [Railway CLI](https://docs.railway.app/develop/cli)
- [Railway Pricing](https://railway.app/pricing)
