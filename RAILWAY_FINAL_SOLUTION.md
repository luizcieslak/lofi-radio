# Railway Deployment - Final Solution

## The Problem

After extensive testing, we discovered Railway's limitations:

1. ❌ **Railway SSH** - Doesn't support stdin piping for file uploads
2. ❌ **`railway up --no-gitignore`** - Cloudflare limits uploads to ~100MB (your songs: 242MB)
3. ❌ **Local deploy** - Not viable for large assets

**Conclusion:** Railway is designed for **GitHub-based deployments only** when you have large assets.

## Working Solution: Private Git Branch

### Setup (One Time)

```bash
# 1. Create a deployment-only branch
git checkout -b railway-deploy

# 2. Force-add songs despite gitignore
git add -f songs/*.mp3

# 3. Commit songs
git commit -m "Add songs for Railway deployment"

# 4. Push to GitHub
git push origin railway-deploy

# 5. Configure Railway to deploy from this branch
# Railway Dashboard → Settings → Source → Deploy Branch: railway-deploy

# 6. Return to main branch
git checkout main
```

### Repository Structure

```
main branch (public):
  - Code only
  - songs/ is gitignored
  - Safe to open source

railway-deploy branch (can be private):
  - Code + songs
  - songs/ committed to git
  - Used only for Railway deployment
```

### Workflow

**Update Code (main branch):**
```bash
# Work on main as usual
git checkout main
# ... make changes ...
git commit -m "Update feature"
git push origin main

# Merge to deployment branch
git checkout railway-deploy
git merge main
git push origin railway-deploy
# Railway auto-deploys with code changes + existing songs
```

**Update Songs:**
```bash
# Switch to deployment branch
git checkout railway-deploy

# Add/remove songs
cp new-song.mp3 songs/
rm songs/old-song.mp3

# Commit and push
git add -f songs/*
git commit -m "Update playlist"
git push origin railway-deploy
# Railway auto-deploys

# Return to main
git checkout main
```

### Advantages

- ✅ Works within Railway's constraints
- ✅ Auto-deploys on push
- ✅ Main branch stays clean (open-sourceable)
- ✅ No upload size limits (GitHub handles large files)
- ✅ Simple workflow once set up

### Disadvantages

- ⚠️ Songs are in git (on railway-deploy branch)
- ⚠️ ~5-10s downtime when updating songs
- ⚠️ Need to manage two branches

## Alternative: HTTP Upload API + Volume

If you don't want songs in git at all, implement an upload endpoint. This requires code changes but provides zero-downtime updates. See docs/deployment/railway.md "Advanced" section for details.

## Recommendation

**Use the private branch approach.** It's the simplest solution that works with Railway's architecture. Your main branch stays clean for open source, and the railway-deploy branch is just for deployment.
