# Android TV Remote - Railway Deployment Guide

## Quick Deploy to Railway

### Step 1: Prerequisites
- GitHub account with your code pushed to a repository
- Railway account (https://railway.app)
- $5 initial credit required by Railway (one-time)

### Step 2: Deploy Cloud Server

#### Method A: Railway GitHub App (Recommended)

1. **Navigate to Railway**
   - Go to https://railway.app
   - Sign up or log in

2. **Create New Project**
   - Click "New Project"
   - Select "Deploy from GitHub repo"
   - Authorize Railway to access GitHub if prompted

3. **Select Your Repository**
   - Choose `robloc fame/facilities` or the repository containing your code
   - Railway auto-detects the Dockerfile

4. **Configure Environment Variables**
   - Click on the deployed service
   - Go to "Variables" tab
   - Add these variables:
     ```
     PORT=5000
     NODE_ENV=production
     ```

5. **Enable Public Internet**
   - Go to "Settings" → "Networking"
   - Enable "Public Internet"
   - Railway assigns a domain like `https://your-app-xxxx.up.railway.app`

6. **Deploy**
   - Railway automatically builds and deploys
   - Watch the deployment logs
   - Status changes to "Deployed" when ready

#### Method B: Railway CLI

```bash
# Install Railway CLI
npm i -g @railway/cli

# Login
railway login

# Navigate to facilities folder
cd c:\Users\Samrat\Desktop\robloc fame\facilities

# Initialize project
railway init

# Link to project
railway link

# Set environment variables
railway variables set PORT=5000
railway variables set NODE_ENV=production

# Enable public internet
railway networking expose

# Deploy
railway up
```

### Step 3: Verify Deployment

1. **Check Health**
   ```bash
   # Your Railway URL (found in Settings → Domains)
   curl https://your-app-xxxx.up.railway.app
   ```

2. **View Logs**
   ```bash
   railway logs
   ```
   Should show: `✅ Cloud server running on port 5000`

### Step 4: Bridge Agent Configuration

After deploying the cloud server:

1. **Get your Railway URL**
   - Go to Settings → Domains
   - Copy the domain (e.g., `https://tv-remote-xxxx.up.railway.app`)

2. **Update Bridge Agent**
   - Edit `.env.local` in your home network computer
   - Set:
     ```
     CLOUD_SERVER_URL=wss://your-railway-url.up.railway.app:443
     ```

3. **Run Bridge Agent**
   ```bash
   cd c:\Users\Samrat\Desktop\robloc fame\facilities
   docker-compose -f docker-compose.cloud.yml up -d bridge-agent
   ```

## Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 5000 | Server port (Railway sets this automatically) |
| NODE_ENV | production | Environment mode |

## Troubleshooting

### Build Fails
- Check Railway build logs in dashboard
- Ensure `Dockerfile` is in the same folder as your code
- Verify all dependencies are in `package.json`

### Service Won't Start
- Check health check logs: `railway logs`
- Ensure `PORT` environment variable is set
- Verify `remote-cloud-server.js` exists in the repository

### Connection Issues
- Ensure "Public Internet" is enabled in Settings
- Check that firewall allows outbound connections from Railway
- Verify bridge agent can reach the Railway URL

## Resource Allocation

Railway Free Tier:
- 512 MB RAM
- 1 CPU core
- 500 GB/month bandwidth
- Your cloud server should use ~100-200 MB RAM, ~5MB bandwidth

## Updating

Code changes automatically deploy when you push to GitHub:

```bash
# Make changes locally
git add .
git commit -m "Update cloud server"
git push origin main

# Railway auto-deploys within 1-2 minutes
```

## Monitoring

```bash
# Real-time logs
railway logs --follow

# Service status
railway status

# View metrics
railway metrics
```

## Security Notes

- Railway provides HTTPS by default
- Consider adding authentication for multi-user scenarios
- Bridge agent communicates via WebSocket over WSS (encrypted)
- TV commands are relayed securely through the bridge

## Support

- Railway Docs: https://docs.railway.app
- Railway Status: https://status.railway.app
- Project Issues: [Add your GitHub issues URL]