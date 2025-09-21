#!/bin/bash

set -e

echo "🚀 Setting up Zevium.dev development environment..."

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Add mise to PATH if not already present
if ! command_exists mise; then
    echo "📦 Adding mise to PATH..."
    export PATH="$HOME/.local/bin:$PATH"
    
    # Add to shell profiles
    for profile in ~/.bashrc ~/.zshrc ~/.profile; do
        if [[ -f "$profile" ]]; then
            if ! grep -q 'mise' "$profile"; then
                echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$profile"
            fi
        fi
    done
    
    # Source the current shell
    if [[ -f ~/.bashrc ]]; then
        source ~/.bashrc
    fi
fi

# Verify mise is available after PATH setup
if ! command_exists mise; then
    echo "⚠️  Warning: mise not found in PATH. The mise feature should handle installation."
    echo "ℹ️  If this fails, mise will be installed by the devcontainer feature."
else
    echo "✅ Found mise CLI"
fi

# Trust mise configuration if mise is available
if command_exists mise; then
    echo "🔧 Trusting mise configuration..."
    mise trust
    
    # Install tools (Node.js and other tools defined in mise.toml)
    echo "📦 Installing tools via mise..."
    mise install
fi

# Install pnpm globally if not available
if ! command_exists pnpm; then
    echo "📦 Installing pnpm globally..."
    npm i -g pnpm
else
    echo "✅ Found pnpm: $(pnpm --version)"
fi

# Copy .env.example to .env
echo "📝 Setting up environment variables..."
if [ ! -f .env ]; then
    cp .env.example .env
    echo "✅ Created .env file from .env.example"
    echo "⚠️  Please update .env with your actual environment variables"
else
    echo "ℹ️  .env file already exists"
fi

# Install dependencies
echo "📦 Installing project dependencies..."
pnpm install

# Run type checking to verify everything works
echo "🔍 Running type check..."
pnpm typecheck

echo ""
echo "🎉 Development environment setup complete!"
echo ""
echo "🚀 Available commands:"
echo "   pnpm dev          - Start development server"
echo "   pnpm build        - Build for production"
echo "   pnpm lint         - Run ESLint"
echo "   pnpm typecheck    - Run TypeScript compiler"
echo "   pnpm ci           - Run all checks (typecheck + lint + format:check)"
echo ""
echo "🌐 Development server will be available at http://localhost:5173"
echo "📝 Don't forget to update your .env file with actual values!"
echo ""
echo "💡 VS Code extensions will be automatically installed."
echo "🔧 The workspace is configured with optimal settings for this project."