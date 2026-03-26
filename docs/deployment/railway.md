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

## Initial Setup

### 1. Create New Project

```bash
railway init
```

Or link to existing project:
```bash
railway link
```

### 2. Create Volume for Songs

In Railway Dashboard:
1. Go to your project
2. Click on your service
3. Go to **"Volumes"** tab
4. Click **"New Volume"**
5. Configure:
   - **Mount Path:** `/app/songs`
   - **Size:** 1 GB (more than enough for 250MB+ songs)
6. Click **"Add Volume"**

### 3. Upload Songs to Volume

**Option A: Using Railway CLI (Recommended)**

```bash
# Mount the volume locally
railway volume mount songs

# This creates a local mount point. Copy your songs:
rsync -avz --progress ./songs/ /path/to/mounted/volume/

# Unmount when done
railway volume unmount songs
```

**Option B: Using Railway Shell**

```bash
# Open shell in running container
railway shell

# In another terminal, copy files to the container
railway cp ./songs /app/songs

# Or use scp/rsync through railway proxy
```

**Option C: Manual Upload via Dashboard**

Railway doesn't have file upload UI yet, so CLI is the best option.

### 4. Deploy

```bash
# Deploy from GitHub (recommended)
railway up

# Or deploy from local directory
railway up --detach
```

## Configuration

### Environment Variables

Railway automatically provides:
- `PORT` - Your app already reads this via `process.env.PORT`

**No additional env vars needed!**

### Volume Persistence

The volume at `/app/songs` will persist across:
- ✅ Deployments
- ✅ Restarts
- ✅ Crashes
- ✅ Rollbacks

Your `state.json` file in `src/state/` will also persist as it's written to the container filesystem.

## Updating Songs

### Add New Songs

```bash
# Mount volume
railway volume mount songs

# Copy new songs
cp new-song.mp3 /path/to/mounted/volume/

# Restart service to pick up new songs
railway restart

# Unmount
railway volume unmount songs
```

### Replace All Songs

```bash
railway volume mount songs
rm -rf /path/to/mounted/volume/*
rsync -avz ./songs/ /path/to/mounted/volume/
railway restart
railway volume unmount songs
```

## Monitoring

### View Logs

```bash
railway logs
```

### Check Status

```bash
railway status
```

### Open in Browser

```bash
railway open
```

Or visit: `https://<your-service>.railway.app`

## Troubleshooting

### "No tracks available"

**Cause:** Volume not mounted or songs not uploaded

**Fix:**
```bash
railway shell
ls -la /app/songs  # Check if songs exist
```

If empty, follow **"Upload Songs to Volume"** steps above.

### Port Binding Issues

**Cause:** App not reading Railway's `PORT` env var

**Fix:** Already handled! `src/server.ts` reads `process.env.PORT || 5634`

### Build Failures

**Cause:** Large build context

**Fix:** Already handled via `.dockerignore` - songs excluded from build

### Volume Not Persisting

**Cause:** Volume mount path mismatch

**Fix:** Ensure volume mount path is exactly `/app/songs` in Railway dashboard

### State Not Persisting

**Cause:** `state.json` is written to container filesystem (not volume)

**Solution:** Already works! Railway containers have persistent storage for non-volume files. However, if you want extra durability:

1. Create second volume: `/app/src/state`
2. Or: Write state to existing `/app/songs` volume (e.g., `/app/songs/.state.json`)

## Deployment Workflow

### Standard Deploy

```bash
git add .
git commit -m "Update server"
git push origin main
```

Railway auto-deploys on push (if connected to GitHub).

### Quick Deploy Without Git

```bash
railway up --detach
```

### Rollback

```bash
railway rollback
```

## Cost Estimation

**Railway Free Tier:**
- ✅ 1 GB volume (covers 250MB songs)
- ✅ $5/month free credit
- ✅ Should be enough for low-traffic radio

**Paid Usage:**
- Volume: Included in plan
- Compute: ~$0.000463/min (~$20/month for 24/7)
- Bandwidth: First 100GB free

**Estimate for 24/7 streaming:**
- 10 concurrent listeners @ 128kbps MP3
- ~500GB/month bandwidth
- **Total: ~$20-30/month**

## Advanced: Multiple Environments

### Staging

```bash
railway environment staging
railway up
```

### Production

```bash
railway environment production
railway up
```

Each environment can have its own volume and songs.

## Backup Songs

Since songs are in a volume:

```bash
# Backup
railway volume mount songs
tar -czf songs-backup.tar.gz /path/to/mounted/volume
railway volume unmount songs

# Restore
railway volume mount songs
tar -xzf songs-backup.tar.gz -C /path/to/mounted/volume
railway volume unmount songs
```

## Next Steps

1. **Set up custom domain** (if desired): Railway dashboard → Domains
2. **Add monitoring:** Railway dashboard → Observability
3. **Scale up:** Railway dashboard → Settings → Increase resources
4. **Add CD pipeline:** Already enabled via GitHub integration

## Resources

- [Railway Docs](https://docs.railway.app/)
- [Railway Volumes](https://docs.railway.app/guides/volumes)
- [Railway CLI](https://docs.railway.app/develop/cli)
