#!/data/data/com.termux/files/usr/bin/sh
# Online Remote — run the whole remote FROM your phone. No laptop, no Cast.
# In Termux, paste these two lines:
#   curl -sL https://raw.githubusercontent.com/Innovator123-sudo/Online-remote/main/termux-setup.sh -o setup.sh && sh setup.sh
# Then open http://localhost:5000 in Chrome. Done.
set -e
pkg update -y
pkg install -y nodejs git android-tools
if [ ! -d "$HOME/online-remote" ]; then
  git clone https://github.com/Innovator123-sudo/Online-remote.git "$HOME/online-remote"
else
  (cd "$HOME/online-remote" && git pull --ff-only || true)
fi
cd "$HOME/online-remote"
echo ""
echo "✅ Installed. Starting the remote — open http://localhost:5000 in Chrome."
echo "   On the TV: enable Developer options → Network/USB debugging, accept once."
echo ""
node server.js
