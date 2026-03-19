#!/bin/bash
set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
print_header() {
    echo -e "\n${BLUE}========================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}========================================${NC}\n"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

# Detect OS
if [[ "$OSTYPE" == "darwin"* ]]; then
    OS_TYPE="macos"
elif [[ "$OSTYPE" == "linux-gnu"* ]] || [[ "$(uname)" == "Linux" ]]; then
    OS_TYPE="linux"
else
    print_error "Unsupported OS: $OSTYPE. Only macOS and Linux are supported."
    exit 1
fi

print_header "RemoteLab Setup (${OS_TYPE})"

echo "This script will help you set up remote browser access to AI coding tools."
echo ""
echo "Choose an access mode:"
echo "  1) Cloudflare  - HTTPS access from anywhere via a Cloudflare Tunnel"
echo "  2) Localhost   - HTTP access on this machine only (no Cloudflare needed)"
echo ""
read -p "Enter 1 or 2 [default: 1]: " MODE_CHOICE
MODE_CHOICE=${MODE_CHOICE:-1}

if [[ "$MODE_CHOICE" == "2" ]]; then
    USE_CLOUDFLARE=false
    print_success "Mode: Localhost only (http://127.0.0.1:7690)"
else
    USE_CLOUDFLARE=true
    print_success "Mode: Cloudflare HTTPS"
fi
echo ""
read -p "Press Enter to continue..."

# Step 1: Gather configuration
print_header "Step 1: Configuration"

# Get current user
CURRENT_USER=$(whoami)
USER_HOME="$HOME"

echo "Current user: $CURRENT_USER"
echo "Home directory: $USER_HOME"
echo "OS: $OS_TYPE"
echo ""

if [[ "$USE_CLOUDFLARE" == true ]]; then
    # Get domain
    while true; do
        read -p "Enter your domain (e.g., example.com): " DOMAIN
        if [[ -z "$DOMAIN" ]]; then
            print_error "Domain cannot be empty"
        else
            break
        fi
    done

    # Get subdomain
    read -p "Enter subdomain for remote access (default: remotelab): " SUBDOMAIN
    SUBDOMAIN=${SUBDOMAIN:-remotelab}
    FULL_DOMAIN="${SUBDOMAIN}.${DOMAIN}"

    print_success "Will configure: https://${FULL_DOMAIN}"
fi

# Generate access token
print_info "Generating access token..."
TOKEN_OUTPUT=$(node "$SCRIPT_DIR/generate-token.mjs" 2>&1)
echo "$TOKEN_OUTPUT"
ACCESS_TOKEN=$(echo "$TOKEN_OUTPUT" | grep "Your access token:" | sed 's/.*Your access token: //')
echo ""
print_warning "Save this token now! It will be your only way to log in."
read -p "Press Enter to continue once you have saved it..."
print_success "Authentication configured"

# Step 2: Check dependencies
print_header "Step 2: Checking Dependencies"

MISSING_DEPS=()

# Check Node.js
if ! command -v node &> /dev/null; then
    print_error "Node.js not found"
    MISSING_DEPS+=("node")
else
    NODE_PATH=$(which node)
    print_success "Node.js installed at: $NODE_PATH"
fi

# Check at least one AI tool
if command -v claude &> /dev/null; then
    print_success "Claude CLI found: $(which claude)"
elif command -v codex &> /dev/null; then
    print_success "Codex CLI found: $(which codex)"
elif command -v cline &> /dev/null; then
    print_success "Cline CLI found: $(which cline)"
else
    print_warning "No AI CLI tool found (claude / codex / cline). Install at least one before using RemoteLab."
fi

# Check cloudflared (only needed in Cloudflare mode)
INSTALL_CLOUDFLARED=false
if [[ "$USE_CLOUDFLARE" == true ]]; then
    if ! command -v cloudflared &> /dev/null; then
        print_warning "cloudflared not found, will install"
        INSTALL_CLOUDFLARED=true
    else
        print_success "cloudflared installed"
    fi
fi

# Check macOS-specific: Homebrew
if [[ "$OS_TYPE" == "macos" ]]; then
    if ! command -v brew &> /dev/null; then
        print_error "Homebrew not found (required on macOS)"
        MISSING_DEPS+=("homebrew")
    else
        print_success "Homebrew installed"
    fi
fi

# Exit if critical dependencies missing
if [[ ${#MISSING_DEPS[@]} -gt 0 ]]; then
    print_error "Missing critical dependencies: ${MISSING_DEPS[*]}"
    echo ""
    echo "Please install:"
    for dep in "${MISSING_DEPS[@]}"; do
        case $dep in
            homebrew)
                echo "  Homebrew: /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
                ;;
            node)
                if [[ "$OS_TYPE" == "macos" ]]; then
                    echo "  Node.js: brew install node (or download from https://nodejs.org)"
                else
                    echo "  Node.js: curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs"
                fi
                ;;
        esac
    done
    exit 1
fi

# Step 3: Install missing packages
if [[ "$INSTALL_CLOUDFLARED" == true ]]; then
    print_header "Step 3: Installing Packages"

    if [[ "$OS_TYPE" == "macos" ]]; then
        PACKAGES=()
        [[ "$INSTALL_CLOUDFLARED" == true ]] && PACKAGES+=("cloudflared")

        print_info "Installing via Homebrew: ${PACKAGES[*]}"
        brew install "${PACKAGES[@]}"
        print_success "Packages installed"
    else
        # Linux installation
        if [[ "$INSTALL_CLOUDFLARED" == true ]]; then
            print_info "Installing cloudflared..."
            ARCH=$(uname -m)
            case "$ARCH" in
                x86_64)  CF_ARCH="amd64" ;;
                aarch64) CF_ARCH="arm64" ;;
                armv7l)  CF_ARCH="arm" ;;
                *)       print_error "Unsupported architecture: $ARCH"; exit 1 ;;
            esac
            if command -v apt-get &> /dev/null; then
                curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg > /dev/null
                echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
                sudo apt-get update && sudo apt-get install -y cloudflared
            else
                curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}" -o /tmp/cloudflared
                chmod +x /tmp/cloudflared
                sudo mv /tmp/cloudflared /usr/local/bin/cloudflared
            fi
            print_success "cloudflared installed"
        fi
    fi
fi

# Step 4: Cloudflare setup (skipped in localhost mode)
if [[ "$USE_CLOUDFLARE" == true ]]; then
    print_header "Step 4: Cloudflare Setup"

    echo "You need to:"
    echo "1. Have a Cloudflare account (free plan works)"
    echo "2. Add your domain ($DOMAIN) to Cloudflare"
    echo "3. Update nameservers at your registrar to point to Cloudflare"
    echo ""
    read -p "Have you completed these steps? (y/n): " CLOUDFLARE_READY

    if [[ "$CLOUDFLARE_READY" != "y" ]]; then
        print_warning "Please complete Cloudflare setup first:"
        echo "  1. Go to https://dash.cloudflare.com"
        echo "  2. Add your domain: $DOMAIN"
        echo "  3. Update nameservers at your registrar"
        echo "  4. Wait for nameserver propagation (5-30 minutes)"
        echo ""
        echo "Run this script again when ready."
        exit 0
    fi

    # Authenticate cloudflared (skip if already authenticated)
    if [[ -f "$HOME/.cloudflared/cert.pem" ]]; then
        print_success "Cloudflared already authenticated (cert.pem exists)"
    else
        print_info "Authenticating cloudflared..."
        echo "A browser will open. Please select your domain: $DOMAIN"
        read -p "Press Enter to continue..."

        cloudflared tunnel login

        if [[ ! -f "$HOME/.cloudflared/cert.pem" ]]; then
            print_error "Authentication failed. cert.pem not found."
            exit 1
        fi

        print_success "Cloudflared authenticated"
    fi

    # Create tunnel
    print_info "Creating Cloudflare tunnel..."
    TUNNEL_NAME="remotelab-$(date +%s)"
    TUNNEL_OUTPUT=$(cloudflared tunnel create "$TUNNEL_NAME")
    TUNNEL_ID=$(echo "$TUNNEL_OUTPUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)

    if [[ -z "$TUNNEL_ID" ]]; then
        print_error "Failed to create tunnel"
        exit 1
    fi

    print_success "Tunnel created: $TUNNEL_NAME (ID: $TUNNEL_ID)"

    # Route DNS
    print_info "Routing DNS..."
    cloudflared tunnel route dns --overwrite-dns "$TUNNEL_NAME" "$FULL_DOMAIN"
    print_success "DNS routed: $FULL_DOMAIN → tunnel"
fi

# Step 5: Create configuration files
print_header "Step 5: Creating Configuration Files"

mkdir -p "$HOME/.local/bin"

if [[ "$USE_CLOUDFLARE" == true ]]; then
    mkdir -p "$HOME/.cloudflared"

    print_info "Creating cloudflared config..."
    cat > "$HOME/.cloudflared/config.yml" << EOF
tunnel: $TUNNEL_NAME
credentials-file: $HOME/.cloudflared/$TUNNEL_ID.json
protocol: http2

ingress:
  - hostname: $FULL_DOMAIN
    service: http://127.0.0.1:7690
  - service: http_status:404
EOF
    print_success "Created: ~/.cloudflared/config.yml"
fi

# Remove old terminal fallback helper if present
rm -f "$HOME/.local/bin/claude-ttyd-session"

# Set up log directory
if [[ "$OS_TYPE" == "macos" ]]; then
    LOG_DIR="$HOME/Library/Logs"
else
    LOG_DIR="$HOME/.local/share/remotelab/logs"
fi
mkdir -p "$LOG_DIR"

# Step 6: Create service management scripts
print_header "Step 6: Creating Service Management Scripts"

if [[ "$OS_TYPE" == "macos" ]]; then
    # ── macOS: LaunchAgent plists ─────────────────────────────────────────────
    mkdir -p "$HOME/Library/LaunchAgents"

    # Remove legacy terminal-fallback plists if present
    if [ -f "$HOME/Library/LaunchAgents/com.ttyd.claude.plist" ]; then
        launchctl unload "$HOME/Library/LaunchAgents/com.ttyd.claude.plist" 2>/dev/null || true
        rm -f "$HOME/Library/LaunchAgents/com.ttyd.claude.plist"
        print_success "Removed legacy shared ttyd service plist"
    fi
    if [ -f "$HOME/Library/LaunchAgents/com.authproxy.claude.plist" ]; then
        launchctl unload "$HOME/Library/LaunchAgents/com.authproxy.claude.plist" 2>/dev/null || true
        rm -f "$HOME/Library/LaunchAgents/com.authproxy.claude.plist"
        print_success "Removed legacy auth-proxy service plist"
    fi

    # Create chat-server launchd plist
    print_info "Creating chat-server service..."
    if [[ "$USE_CLOUDFLARE" == true ]]; then
        cat > "$HOME/Library/LaunchAgents/com.chatserver.claude.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.chatserver.claude</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/caffeinate</string>
        <string>-s</string>
        <string>$(which node)</string>
        <string>$SCRIPT_DIR/chat-server.mjs</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>REMOTELAB_ENABLE_ACTIVE_RELEASE</key>
        <string>1</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>$USER_HOME</string>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/chat-server.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/chat-server.error.log</string>
</dict>
</plist>
EOF
    else
        cat > "$HOME/Library/LaunchAgents/com.chatserver.claude.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.chatserver.claude</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(which node)</string>
        <string>$SCRIPT_DIR/chat-server.mjs</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>REMOTELAB_ENABLE_ACTIVE_RELEASE</key>
        <string>1</string>
        <key>SECURE_COOKIES</key>
        <string>0</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>$USER_HOME</string>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/chat-server.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/chat-server.error.log</string>
</dict>
</plist>
EOF
    fi
    print_success "Created: ~/Library/LaunchAgents/com.chatserver.claude.plist"

    if [[ "$USE_CLOUDFLARE" == true ]]; then
        print_info "Creating cloudflared service..."
        cat > "$HOME/Library/LaunchAgents/com.cloudflared.tunnel.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.cloudflared.tunnel</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(which cloudflared)</string>
        <string>tunnel</string>
        <string>run</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>$USER_HOME</string>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/cloudflared.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/cloudflared.error.log</string>
</dict>
</plist>
EOF
        print_success "Created: ~/Library/LaunchAgents/com.cloudflared.tunnel.plist"
    fi

    # Create macOS start.sh
    print_info "Creating start.sh..."
    cat > "$SCRIPT_DIR/start.sh" << 'STARTEOF'
#!/bin/bash
echo "Starting RemoteLab services..."
if [ -f ~/Library/LaunchAgents/com.chatserver.claude.plist ]; then
  launchctl load ~/Library/LaunchAgents/com.chatserver.claude.plist 2>/dev/null || echo "chat-server already loaded"
fi
if [ -f ~/Library/LaunchAgents/com.cloudflared.tunnel.plist ]; then
  launchctl load ~/Library/LaunchAgents/com.cloudflared.tunnel.plist 2>/dev/null || echo "cloudflared already loaded"
fi
echo "Services started!"
echo ""
echo "Check status with:"
echo "  launchctl list | grep -E 'chatserver|cloudflared'"
STARTEOF
    chmod +x "$SCRIPT_DIR/start.sh"
    print_success "Created: start.sh"

    # Create macOS stop.sh
    print_info "Creating stop.sh..."
    cat > "$SCRIPT_DIR/stop.sh" << 'STOPEOF'
#!/bin/bash
echo "Stopping RemoteLab services..."
launchctl unload ~/Library/LaunchAgents/com.chatserver.claude.plist 2>/dev/null || echo "chat-server not loaded"
if [ -f ~/Library/LaunchAgents/com.cloudflared.tunnel.plist ]; then
  launchctl unload ~/Library/LaunchAgents/com.cloudflared.tunnel.plist 2>/dev/null || echo "cloudflared not loaded"
fi
echo "Services stopped!"
STOPEOF
    chmod +x "$SCRIPT_DIR/stop.sh"
    print_success "Created: stop.sh"

else
    # ── Linux: systemd user services ─────────────────────────────────────────
    SYSTEMD_DIR="$HOME/.config/systemd/user"
    mkdir -p "$SYSTEMD_DIR"

    NODE_BIN=$(which node)

    # Create chat-server systemd service
    print_info "Creating chat-server systemd service..."
    if [[ "$USE_CLOUDFLARE" == true ]]; then
        cat > "$SYSTEMD_DIR/remotelab-chat.service" << EOF
[Unit]
Description=RemoteLab Chat Server
After=network.target

[Service]
Type=simple
WorkingDirectory=$USER_HOME
ExecStart=$NODE_BIN $SCRIPT_DIR/chat-server.mjs
Restart=always
RestartSec=5
StandardOutput=append:$LOG_DIR/chat-server.log
StandardError=append:$LOG_DIR/chat-server.error.log
Environment=NODE_ENV=production
Environment=REMOTELAB_ENABLE_ACTIVE_RELEASE=1

[Install]
WantedBy=default.target
EOF
    else
        cat > "$SYSTEMD_DIR/remotelab-chat.service" << EOF
[Unit]
Description=RemoteLab Chat Server
After=network.target

[Service]
Type=simple
WorkingDirectory=$USER_HOME
ExecStart=$NODE_BIN $SCRIPT_DIR/chat-server.mjs
Restart=always
RestartSec=5
StandardOutput=append:$LOG_DIR/chat-server.log
StandardError=append:$LOG_DIR/chat-server.error.log
Environment=NODE_ENV=production
Environment=REMOTELAB_ENABLE_ACTIVE_RELEASE=1
Environment=SECURE_COOKIES=0

[Install]
WantedBy=default.target
EOF
    fi
    print_success "Created: ~/.config/systemd/user/remotelab-chat.service"

    if [[ -f "$SYSTEMD_DIR/remotelab-proxy.service" ]]; then
        systemctl --user stop remotelab-proxy.service 2>/dev/null || true
        systemctl --user disable remotelab-proxy.service 2>/dev/null || true
        rm -f "$SYSTEMD_DIR/remotelab-proxy.service"
        print_success "Removed legacy remotelab-proxy.service"
    fi

    if [[ "$USE_CLOUDFLARE" == true ]]; then
        print_info "Creating cloudflared systemd service..."
        CLOUDFLARED_BIN=$(which cloudflared)
        cat > "$SYSTEMD_DIR/remotelab-tunnel.service" << EOF
[Unit]
Description=RemoteLab Cloudflare Tunnel
After=network.target

[Service]
Type=simple
WorkingDirectory=$USER_HOME
ExecStart=$CLOUDFLARED_BIN tunnel run
Restart=always
RestartSec=5
StandardOutput=append:$LOG_DIR/cloudflared.log
StandardError=append:$LOG_DIR/cloudflared.error.log

[Install]
WantedBy=default.target
EOF
        print_success "Created: ~/.config/systemd/user/remotelab-tunnel.service"
    fi

    # Reload systemd user daemon
    systemctl --user daemon-reload

    # Create Linux start.sh
    print_info "Creating start.sh..."
    cat > "$SCRIPT_DIR/start.sh" << 'STARTEOF'
#!/bin/bash
echo "Starting RemoteLab services..."
systemctl --user start remotelab-chat.service
if systemctl --user list-unit-files remotelab-tunnel.service &>/dev/null; then
  systemctl --user start remotelab-tunnel.service
fi
echo "Services started!"
echo ""
echo "Check status with:"
echo "  systemctl --user status remotelab-chat"
echo ""
echo "View logs:"
echo "  journalctl --user -u remotelab-chat -f"
STARTEOF
    chmod +x "$SCRIPT_DIR/start.sh"
    print_success "Created: start.sh"

    # Create Linux stop.sh
    print_info "Creating stop.sh..."
    cat > "$SCRIPT_DIR/stop.sh" << 'STOPEOF'
#!/bin/bash
echo "Stopping RemoteLab services..."
systemctl --user stop remotelab-chat.service 2>/dev/null || echo "chat-server not running"
systemctl --user stop remotelab-tunnel.service 2>/dev/null || true
echo "Services stopped!"
STOPEOF
    chmod +x "$SCRIPT_DIR/stop.sh"
    print_success "Created: stop.sh"

    # Enable lingering so services survive logout (optional, requires sudo)
    if command -v loginctl &> /dev/null; then
        print_info "Enabling systemd user lingering (services survive logout)..."
        loginctl enable-linger "$CURRENT_USER" 2>/dev/null && \
            print_success "Lingering enabled" || \
            print_warning "Could not enable lingering (may need sudo). Services will stop on logout."
    fi
fi

# Create credentials file
print_info "Creating credentials.txt..."
if [[ "$USE_CLOUDFLARE" == true ]]; then
    cat > "$SCRIPT_DIR/credentials.txt" << EOF
# RemoteLab Remote Access Credentials
# Generated: $(date)
# OS: $OS_TYPE

Access URL: https://$FULL_DOMAIN/?token=$ACCESS_TOKEN

Domain: $DOMAIN
Subdomain: $SUBDOMAIN
Tunnel Name: $TUNNEL_NAME
Tunnel ID: $TUNNEL_ID

# Management:
Start services: $SCRIPT_DIR/start.sh
Stop services:  $SCRIPT_DIR/stop.sh

# KEEP THIS FILE SECURE!
EOF
else
    cat > "$SCRIPT_DIR/credentials.txt" << EOF
# RemoteLab Local Access Credentials
# Generated: $(date)
# OS: $OS_TYPE
# Mode: Localhost only (no Cloudflare)

Access URL: http://127.0.0.1:7690/?token=$ACCESS_TOKEN

# Management:
Start services: $SCRIPT_DIR/start.sh
Stop services:  $SCRIPT_DIR/stop.sh

# KEEP THIS FILE SECURE!
EOF
fi
chmod 600 "$SCRIPT_DIR/credentials.txt"
print_success "Created: credentials.txt (saved securely)"

# Step 7: Start services
print_header "Step 7: Starting Services"

# Stop any already-running instances
print_info "Stopping any existing services..."
if [[ "$OS_TYPE" == "macos" ]]; then
    launchctl unload "$HOME/Library/LaunchAgents/com.chatserver.claude.plist" 2>/dev/null || true
    launchctl unload "$HOME/Library/LaunchAgents/com.authproxy.claude.plist" 2>/dev/null || true
    if [[ "$USE_CLOUDFLARE" == true ]]; then
        launchctl unload "$HOME/Library/LaunchAgents/com.cloudflared.tunnel.plist" 2>/dev/null || true
    fi
else
    systemctl --user stop remotelab-chat.service 2>/dev/null || true
    systemctl --user stop remotelab-proxy.service 2>/dev/null || true
    if [[ "$USE_CLOUDFLARE" == true ]]; then
        systemctl --user stop remotelab-tunnel.service 2>/dev/null || true
    fi
fi

pkill -f chat-server.mjs 2>/dev/null || true
pkill -f auth-proxy.mjs 2>/dev/null || true
lsof -ti :7690 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 2

print_info "Loading services..."
if [[ "$OS_TYPE" == "macos" ]]; then
    launchctl load "$HOME/Library/LaunchAgents/com.chatserver.claude.plist"
    if [[ "$USE_CLOUDFLARE" == true ]]; then
        launchctl load "$HOME/Library/LaunchAgents/com.cloudflared.tunnel.plist"
    fi
    sleep 3

    service_pid() { launchctl list | awk -v svc="$1" '$3 == svc && $1 ~ /^[0-9]+$/ {print $1}'; }
    CHATSERVER_PID=$(service_pid "com.chatserver.claude")
    if [[ -n "$CHATSERVER_PID" ]]; then
        print_success "chat-server running (PID $CHATSERVER_PID)"
    else
        print_error "chat-server failed to start — check $LOG_DIR/chat-server.error.log"
    fi
    if [[ "$USE_CLOUDFLARE" == true ]]; then
        CLOUDFLARED_PID=$(service_pid "com.cloudflared.tunnel")
        if [[ -n "$CLOUDFLARED_PID" ]]; then
            print_success "cloudflared running (PID $CLOUDFLARED_PID)"
        else
            print_error "cloudflared failed to start — check $LOG_DIR/cloudflared.error.log"
        fi
    fi
else
    systemctl --user enable remotelab-chat.service 2>/dev/null || true
    systemctl --user start remotelab-chat.service
    if [[ "$USE_CLOUDFLARE" == true ]]; then
        systemctl --user enable remotelab-tunnel.service 2>/dev/null || true
        systemctl --user start remotelab-tunnel.service
    fi
    sleep 3

    if systemctl --user is-active --quiet remotelab-chat.service; then
        print_success "chat-server running"
    else
        print_error "chat-server failed to start — check $LOG_DIR/chat-server.error.log"
    fi
    if [[ "$USE_CLOUDFLARE" == true ]]; then
        if systemctl --user is-active --quiet remotelab-tunnel.service; then
            print_success "cloudflared running"
        else
            print_error "cloudflared failed to start — check $LOG_DIR/cloudflared.error.log"
        fi
    fi
fi

# Final summary
print_header "Setup Complete!"

if [[ "$USE_CLOUDFLARE" == true ]]; then
    echo -e "${GREEN}✓ RemoteLab is now accessible remotely!${NC}"
    echo ""
    echo "Access URL: ${BLUE}https://$FULL_DOMAIN/?token=$ACCESS_TOKEN${NC}"
    echo ""
    print_warning "SAVE THIS URL! It's also in: $SCRIPT_DIR/credentials.txt"
    echo ""
    echo "Next steps:"
    echo "  1. Wait 5-30 minutes for DNS to fully propagate"
    echo "  2. Open the access URL in your browser (or on your phone)"
    echo ""
    echo "Logs:"
    echo "  chat-server: $LOG_DIR/chat-server.log"
    echo "  cloudflared: $LOG_DIR/cloudflared.log"
else
    echo -e "${GREEN}✓ RemoteLab is now accessible locally!${NC}"
    echo ""
    echo "Access URL: ${BLUE}http://127.0.0.1:7690/?token=$ACCESS_TOKEN${NC}"
    echo ""
    print_warning "SAVE THIS URL! It's also in: $SCRIPT_DIR/credentials.txt"
    echo ""
    echo "Logs:"
    echo "  chat-server: $LOG_DIR/chat-server.log"
fi
echo ""
echo "Management commands:"
echo "  Start: $SCRIPT_DIR/start.sh"
echo "  Stop:  $SCRIPT_DIR/stop.sh"
echo ""
print_success "Setup completed successfully!"
