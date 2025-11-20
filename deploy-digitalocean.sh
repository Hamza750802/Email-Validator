#!/bin/bash

###############################################################################
# ValidR Email Validator - DigitalOcean Deployment Script
# 
# This script will:
# 1. Update system packages
# 2. Install Node.js 20
# 3. Install Redis
# 4. Install Nginx (reverse proxy)
# 5. Install PM2 (process manager)
# 6. Clone and build ValidR
# 7. Configure everything for production
# 8. Start the service
#
# Usage:
#   1. SSH into your DigitalOcean droplet
#   2. Run: curl -O https://raw.githubusercontent.com/Hamza750802/Email-Validator/main/deploy-digitalocean.sh
#   3. Run: chmod +x deploy-digitalocean.sh
#   4. Run: sudo ./deploy-digitalocean.sh
#
# Or one-liner:
#   curl -sSL https://raw.githubusercontent.com/Hamza750802/Email-Validator/main/deploy-digitalocean.sh | sudo bash
###############################################################################

set -e  # Exit on any error

echo "🚀 Starting ValidR deployment on DigitalOcean..."
echo ""

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
  echo -e "${RED}Please run as root (use sudo)${NC}"
  exit 1
fi

###############################################################################
# Step 1: Update System
###############################################################################
echo -e "${GREEN}[1/9] Updating system packages...${NC}"
apt update && apt upgrade -y

###############################################################################
# Step 2: Install Node.js 20
###############################################################################
echo -e "${GREEN}[2/9] Installing Node.js 20...${NC}"
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node --version
npm --version

###############################################################################
# Step 3: Install Redis
###############################################################################
echo -e "${GREEN}[3/9] Installing Redis...${NC}"
apt install -y redis-server

# Configure Redis for production
sed -i 's/supervised no/supervised systemd/' /etc/redis/redis.conf
sed -i 's/bind 127.0.0.1 ::1/bind 127.0.0.1/' /etc/redis/redis.conf

# Restart and enable Redis
systemctl restart redis-server
systemctl enable redis-server

# Test Redis
redis-cli ping

echo -e "${GREEN}✅ Redis installed and running${NC}"

###############################################################################
# Step 4: Install Nginx
###############################################################################
echo -e "${GREEN}[4/9] Installing Nginx...${NC}"
apt install -y nginx

###############################################################################
# Step 5: Install PM2
###############################################################################
echo -e "${GREEN}[5/9] Installing PM2 process manager...${NC}"
npm install -g pm2

###############################################################################
# Step 6: Create application user
###############################################################################
echo -e "${GREEN}[6/9] Creating application user...${NC}"
if ! id "validr" &>/dev/null; then
    useradd -m -s /bin/bash validr
    echo -e "${GREEN}✅ User 'validr' created${NC}"
else
    echo -e "${YELLOW}User 'validr' already exists${NC}"
fi

###############################################################################
# Step 7: Clone and build ValidR
###############################################################################
echo -e "${GREEN}[7/9] Cloning ValidR from GitHub...${NC}"

# Switch to validr user home directory
cd /home/validr

# Clone repository (as validr user)
if [ -d "Email-Validator" ]; then
    echo -e "${YELLOW}Repository already exists, pulling latest...${NC}"
    cd Email-Validator
    sudo -u validr git pull
else
    sudo -u validr git clone https://github.com/Hamza750802/Email-Validator.git
    cd Email-Validator
fi

# Install dependencies
echo -e "${GREEN}Installing dependencies...${NC}"
sudo -u validr npm install

# Build TypeScript
echo -e "${GREEN}Building TypeScript...${NC}"
sudo -u validr npm run build

echo -e "${GREEN}✅ ValidR built successfully${NC}"

###############################################################################
# Step 8: Create .env file
###############################################################################
echo -e "${GREEN}[8/9] Creating .env configuration...${NC}"

# Get server IP address
SERVER_IP=$(curl -s ifconfig.me)

cat > /home/validr/Email-Validator/.env << 'EOF'
# Server Configuration
NODE_ENV=production
PORT=4000

# SMTP Configuration - Optimized for DigitalOcean
SMTP_CONNECT_TIMEOUT_MS=30000
SMTP_OVERALL_TIMEOUT_MS=45000

# Per-Phase Timeouts
SMTP_BANNER_TIMEOUT_MS=8000
SMTP_EHLO_TIMEOUT_MS=8000
SMTP_MAIL_TIMEOUT_MS=8000
SMTP_RCPT_TIMEOUT_MS=15000

# SMTP Concurrency (conservative for good reputation)
SMTP_MAX_GLOBAL_CONCURRENCY=3
SMTP_MAX_MX_CONCURRENCY=1
SMTP_PER_DOMAIN_MIN_INTERVAL_MS=5000

# SMTP Retry
SMTP_SOFT_RETRY_LIMIT=2
SMTP_INITIAL_RETRY_DELAY_MS=5000
SMTP_RETRY_BACKOFF_FACTOR=3

# SMTP Identity (CHANGE THIS to your domain!)
SMTP_HELO_DOMAIN=mail.example.com
SMTP_MAIL_FROM=verifier@example.com

# TLS Configuration
SMTP_REQUIRE_TLS=false
SMTP_ALLOW_TLS_DOWNGRADE=true

# MX Strategy
SMTP_MAX_MX_ATTEMPTS=5
SMTP_RANDOMIZE_SAME_PRIORITY=true

# Redis Configuration
REDIS_ENABLED=true
REDIS_URL=redis://localhost:6379
REDIS_KEY_PREFIX=validr:
REDIS_CACHE_TTL_SECONDS=3600
REDIS_THROTTLE_TTL_SECONDS=300

# Rate Limiting
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=100
RATE_LIMIT_SKIP_SUCCESSFUL=false

# Batch Processing
BATCH_SIZE_LIMIT=1000
BATCH_TIMEOUT_MS=300000
EOF

chown validr:validr /home/validr/Email-Validator/.env

echo -e "${YELLOW}⚠️  IMPORTANT: Edit /home/validr/Email-Validator/.env and set:${NC}"
echo -e "${YELLOW}   SMTP_HELO_DOMAIN=mail.yourdomain.com${NC}"
echo -e "${YELLOW}   SMTP_MAIL_FROM=verifier@yourdomain.com${NC}"
echo ""

###############################################################################
# Step 9: Configure Nginx
###############################################################################
echo -e "${GREEN}[9/9] Configuring Nginx reverse proxy...${NC}"

cat > /etc/nginx/sites-available/validr << EOF
server {
    listen 80;
    listen [::]:80;
    server_name _;

    client_max_body_size 10M;

    location / {
        proxy_pass http://localhost:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        
        # Increase timeouts for batch processing
        proxy_connect_timeout 600;
        proxy_send_timeout 600;
        proxy_read_timeout 600;
        send_timeout 600;
    }
}
EOF

# Enable site
ln -sf /etc/nginx/sites-available/validr /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# Test Nginx configuration
nginx -t

# Restart Nginx
systemctl restart nginx
systemctl enable nginx

echo -e "${GREEN}✅ Nginx configured and running${NC}"

###############################################################################
# Start ValidR with PM2
###############################################################################
echo -e "${GREEN}Starting ValidR with PM2...${NC}"

cd /home/validr/Email-Validator

# Start with PM2 as validr user
sudo -u validr pm2 start dist/http/server.js --name validr --time

# Save PM2 process list
sudo -u validr pm2 save

# Setup PM2 to start on boot
env PATH=$PATH:/usr/bin pm2 startup systemd -u validr --hp /home/validr

echo -e "${GREEN}✅ ValidR is running!${NC}"

###############################################################################
# Display status and next steps
###############################################################################
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}🎉 ValidR Deployment Complete!${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo -e "${GREEN}✅ Server IP:${NC} $SERVER_IP"
echo -e "${GREEN}✅ Access URL:${NC} http://$SERVER_IP"
echo -e "${GREEN}✅ Health Check:${NC} http://$SERVER_IP/health"
echo ""
echo -e "${YELLOW}📋 Next Steps:${NC}"
echo ""
echo "1. Set PTR Record (Reverse DNS):"
echo "   - Go to DigitalOcean → Droplets → Your droplet → Networking"
echo "   - Set PTR record to: mail.yourdomain.com"
echo "   - Or use: $SERVER_IP (temporary)"
echo ""
echo "2. Update SMTP Configuration:"
echo "   - Edit: /home/validr/Email-Validator/.env"
echo "   - Set SMTP_HELO_DOMAIN and SMTP_MAIL_FROM to your domain"
echo "   - Then run: pm2 restart validr"
echo ""
echo "3. Test SMTP Validation:"
echo "   - Visit: http://$SERVER_IP"
echo "   - Upload a test CSV with real emails (Gmail, Outlook, etc.)"
echo "   - Check SMTP status (should be 'valid' or 'invalid', not 'unknown')"
echo ""
echo -e "${GREEN}📊 Useful Commands:${NC}"
echo ""
echo "  View logs:        pm2 logs validr"
echo "  Restart app:      pm2 restart validr"
echo "  Stop app:         pm2 stop validr"
echo "  App status:       pm2 status"
echo "  Redis status:     systemctl status redis-server"
echo "  Nginx status:     systemctl status nginx"
echo ""
echo -e "${GREEN}💰 Cost:${NC} \$6/month (FREE with \$200 DigitalOcean credit for new accounts)"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
