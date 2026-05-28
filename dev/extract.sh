#!/usr/bin/env bash
set -euo pipefail

# Extract WoW Interface files into .wow-assets/ for local development and testing.
# Sets you up so scryer.extractedAssetsDir can point at the result.
#
# Retail: auto-detects an installed CASC extraction tool (see CASC_TOOLS below).
# Classic/Classic Era: copies loose files from $WOW_DIR/_classic_/Interface/.
#
# Usage: ./dev/extract.sh [classic|classic_era|retail(default)] [--out-dir <dir>] [--type textures|interface|all] [--paths-file <file>] [--wow-dir <path>] [--casc-tool <path>] [--listfile-dir <dir>]
#
#   --out-dir <dir>       Output root (default: .wow-assets/ beside the project). The extension
#                         passes <cacheRoot>/source here automatically; manual runs use the default.
#   --type textures       Extract Interface texture files (BLP/PNG/TGA). Default.
#   --type interface      Extract Blizzard addon code (Lua/XML/TOC) from Interface/AddOns/.
#   --type all            Extract both textures and addon code.
#   --paths-file          Targeted extraction: a newline-delimited list of specific paths.
#                         Overrides the default path set; --type is ignored.
#   --wow-dir <path>      WoW root directory. Overrides WOW_DIR from config.local.sh.
#                         When provided, config.local.sh is not required.
#   --casc-tool <path>    Path to the CASC extraction binary. Overrides CASC_TOOL from config.local.sh.
#   --listfile-dir <dir>  Directory where community-listfile.csv is downloaded/cached.
#                         Default: dev/ (beside this script). The extension passes
#                         <cacheRoot>/downloads here so nothing is written into the source tree.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
readonly PROJECT_ROOT
readonly CONFIG="$SCRIPT_DIR/config.local.sh"

FLAVOR="${1:-retail}"
OUT_DIR="$PROJECT_ROOT/.wow-assets"
PATHS_FILE=""
TYPE="textures"
WOW_DIR_ARG=""
CASC_TOOL_ARG=""
LISTFILE_DIR="$SCRIPT_DIR"

shift || true # consume flavor arg (or no-op if no args given)

while [[ $# -gt 0 ]]; do
    case "$1" in
        --out-dir)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --out-dir requires an argument" >&2
                exit 1
            fi
            OUT_DIR="$2"
            shift 2
            ;;
        --paths-file)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --paths-file requires an argument" >&2
                exit 1
            fi
            PATHS_FILE="$2"
            shift 2
            ;;
        --type)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --type requires an argument" >&2
                exit 1
            fi
            case "$2" in
                textures|interface|all) ;;
                *)
                    echo "Error: --type must be textures, interface, or all" >&2
                    exit 1
                    ;;
            esac
            TYPE="$2"
            shift 2
            ;;
        --wow-dir)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --wow-dir requires an argument" >&2
                exit 1
            fi
            WOW_DIR_ARG="$2"
            shift 2
            ;;
        --casc-tool)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --casc-tool requires an argument" >&2
                exit 1
            fi
            CASC_TOOL_ARG="$2"
            shift 2
            ;;
        --listfile-dir)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --listfile-dir requires an argument" >&2
                exit 1
            fi
            LISTFILE_DIR="$2"
            shift 2
            ;;
        *)
            echo "Error: Unknown argument: $1" >&2
            echo "Usage: $0 [retail|classic|classic_era] [--out-dir <dir>] [--type textures|interface|all] [--paths-file <file>] [--wow-dir <path>] [--casc-tool <path>] [--listfile-dir <dir>]" >&2
            exit 1
            ;;
    esac
done

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

# Source config.local.sh if it exists (picks up WOW_DIR, WOW_ACCOUNT, CASC_TOOL for
# manual runs). Not required when --wow-dir and --casc-tool are provided by the caller.
if [[ -f "$CONFIG" ]]; then
    # shellcheck source=dev/config.local.sh
    source "$CONFIG"
elif [[ -z "$WOW_DIR_ARG" ]]; then
    echo "Error: $CONFIG not found." >&2
    echo "  Copy dev/config.sh.example → dev/config.local.sh and fill in WOW_DIR," >&2
    echo "  or pass --wow-dir <path> directly." >&2
    exit 1
fi

# CLI args take precedence over config file values.
[[ -n "$WOW_DIR_ARG" ]] && WOW_DIR="$WOW_DIR_ARG"
[[ -n "$CASC_TOOL_ARG" ]] && CASC_TOOL="$CASC_TOOL_ARG"

if [[ -z "${WOW_DIR:-}" ]]; then
    echo "Error: WOW_DIR is not set. Set it in $CONFIG or pass --wow-dir <path>." >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Done message
# ---------------------------------------------------------------------------

print_done() {
    echo ""
    echo "Done. Assets written to:"
    echo "  $OUT_DIR"
    echo ""
    echo "Next step: set scryer.cacheLocation to \"custom\" and scryer.cacheDir to the"
    echo "parent of this directory (the path before /source) in your VSCode settings,"
    echo "or re-run this script via the extension (which passes --out-dir automatically)."
}

# ---------------------------------------------------------------------------
# Retail: CASC tool detection and dispatch
#
# CASC_TOOLS — ordered list of supported tools. First one found on PATH wins.
# Each entry: "binary:label"
# To add a new tool: append an entry here and add an extract_retail_<binary>()
# function below (replacing - with _ in the binary name for the function name).
# ---------------------------------------------------------------------------

readonly -a CASC_TOOLS=(
    "rustydemon-cli:rustydemon-cli (Rust)  https://github.com/HoldMyBeer-gg/rustydemon"
)

extract_retail() {
    local tool_bin="" tool_label=""

    if [[ -n "${CASC_TOOL:-}" ]]; then
        if [[ ! -x "$CASC_TOOL" ]]; then
            echo "Error: CASC_TOOL is set but not executable: $CASC_TOOL" >&2
            exit 1
        fi
        local base
        base="$(basename "$CASC_TOOL")"
        # Verify it's a supported tool so we can dispatch to the right function.
        for entry in "${CASC_TOOLS[@]}"; do
            if [[ "${entry%%:*}" == "$base" ]]; then
                tool_bin="$base"
                tool_label="${entry#*:}"
                # Ensure the explicit path is found when the function calls the binary by name.
                export PATH="$(dirname "$CASC_TOOL"):$PATH"
                break
            fi
        done
        if [[ -z "$tool_bin" ]]; then
            echo "Error: CASC_TOOL binary '$base' is not a supported tool." >&2
            echo "" >&2
            echo "  Supported tools:" >&2
            for entry in "${CASC_TOOLS[@]}"; do
                echo "    ${entry%%:*}" >&2
            done
            exit 1
        fi
    else
        for entry in "${CASC_TOOLS[@]}"; do
            local bin="${entry%%:*}"
            if command -v "$bin" &>/dev/null; then
                tool_bin="$bin"
                tool_label="${entry#*:}"
                break
            fi
        done

        if [[ -z "$tool_bin" ]]; then
            echo "Error: No CASC extraction tool found on PATH." >&2
            echo "" >&2
            echo "  Install one of the following, then re-run this script:" >&2
            for entry in "${CASC_TOOLS[@]}"; do
                echo "    ${entry#*:}" >&2
            done
            exit 1
        fi
    fi

    local version
    version="$("$tool_bin" --version 2>/dev/null || echo "version unknown")"
    echo "CASC tool: $tool_label"
    echo "  $version"
    echo ""

    # Dispatch to tool-specific extraction function.
    # Function name: extract_retail_<binary> with hyphens replaced by underscores.
    local fn="extract_retail_${tool_bin//-/_}"
    "$fn"
}

# ---------------------------------------------------------------------------
# Shared: community listfile (needed by tools that don't auto-download it)
# Downloaded once to LISTFILE_DIR, reused after. Defaults to dev/ for manual
# runs; the extension passes --listfile-dir <cacheRoot>/downloads so nothing
# is written into the source tree.
# ---------------------------------------------------------------------------

ensure_listfile() {
    local listfile="$LISTFILE_DIR/listfile.csv"
    if [[ ! -f "$listfile" ]]; then
        mkdir -p "$LISTFILE_DIR"
        echo "Downloading community listfile to $listfile..." >&2
        curl -fsSL -o "$listfile" \
            "https://github.com/wowdev/wow-listfile/releases/latest/download/community-listfile.csv"
        echo "" >&2
    fi
    echo "$listfile"
}

# ---------------------------------------------------------------------------
# Retail: rustydemon-cli  https://github.com/HoldMyBeer-gg/rustydemon
# Install: cargo install --git https://github.com/HoldMyBeer-gg/rustydemon rustydemon-cli
# Requires a community listfile for WoW path resolution (auto-downloaded).
# Outputs raw files as-is from the CASC archive.
# ---------------------------------------------------------------------------

extract_retail_rustydemon_cli() {
    local listfile
    listfile="$(ensure_listfile)"

    mkdir -p "$OUT_DIR"

    if [[ -n "$PATHS_FILE" ]]; then
        echo "Targeted retail extraction via rustydemon-cli..."
        echo "  Source: $WOW_DIR"
        echo "  Output: $OUT_DIR"
        echo "  Paths:  $PATHS_FILE"
        echo ""

        while IFS= read -r iface_path || [[ -n "$iface_path" ]]; do
            [[ -z "$iface_path" ]] && continue
            echo "  Extracting $iface_path..."
            rustydemon-cli export \
                -a "$WOW_DIR" \
                -p "$iface_path" \
                -l "$listfile" \
                -o "$OUT_DIR" \
                2>&1 | sed 's/^/    /'
        done < "$PATHS_FILE"
    else
        # A minimal set of Interface texture paths for addon preview testing.
        local -a TEXTURE_PATHS=(
            "Interface/Buttons/**"
            "Interface/Common/**"
            "Interface/DialogFrame/**"
            "Interface/FrameGeneral/**"
            "Interface/Icons/**"
            "Interface/Tooltips/**"
        )

        # Blizzard addon directories needed for template corpus and Lua mixin resolution.
        local -a INTERFACE_PATHS=(
            "Interface/AddOns/Blizzard_SharedXML/**"
            "Interface/AddOns/Blizzard_FrameXML/**"
        )

        local -a PATHS=()
        if [[ "$TYPE" == "textures" || "$TYPE" == "all" ]]; then
            PATHS+=("${TEXTURE_PATHS[@]}")
        fi
        if [[ "$TYPE" == "interface" || "$TYPE" == "all" ]]; then
            PATHS+=("${INTERFACE_PATHS[@]}")
        fi

        echo "Extracting retail Interface ($TYPE) via rustydemon-cli..."
        echo "  Source: $WOW_DIR"
        echo "  Output: $OUT_DIR"
        echo ""

        for iface_path in "${PATHS[@]}"; do
            echo "  Extracting $iface_path..."
            rustydemon-cli export \
                -a "$WOW_DIR" \
                -p "$iface_path" \
                -l "$listfile" \
                -o "$OUT_DIR" \
                2>&1 | sed 's/^/    /'
        done
    fi

    print_done
}

# ---------------------------------------------------------------------------
# Classic / Classic Era: loose files (no CASC needed)
# ---------------------------------------------------------------------------

extract_loose() {
    local subdir="$1"
    local src="${WOW_DIR%/}/${subdir}/Interface"

    if [[ ! -d "$src" ]]; then
        echo "Error: Interface directory not found at:" >&2
        echo "  $src" >&2
        echo "" >&2
        echo "  Check that WOW_DIR points at the root WoW folder" >&2
        echo "  (the one that contains _classic_/ and _retail_/)." >&2
        exit 1
    fi

    mkdir -p "$OUT_DIR"

    if [[ -n "$PATHS_FILE" ]]; then
        echo "Targeted Classic extraction..."
        echo "  Source: $src"
        echo "  Output: $OUT_DIR"
        echo "  Paths:  $PATHS_FILE"
        echo ""

        local count=0
        while IFS= read -r iface_path || [[ -n "$iface_path" ]]; do
            [[ -z "$iface_path" ]] && continue

            # Strip leading Interface/ prefix (case-insensitive) — $src is already the Interface/ dir.
            local rel_path
            rel_path="$(echo "$iface_path" | sed 's|^[Ii]nterface/||')"

            # Find the file case-insensitively to handle Linux vs Windows casing.
            local found
            found="$(find "$src" -ipath "*/$rel_path" 2>/dev/null | head -1)"

            if [[ -z "$found" ]]; then
                echo "  Not found: $rel_path (skipping)"
                continue
            fi

            local dest_file="$OUT_DIR/$rel_path"
            mkdir -p "$(dirname "$dest_file")"
            cp "$found" "$dest_file"
            echo "  Copied $rel_path"
            count=$((count + 1))
        done < "$PATHS_FILE"

        echo ""
        echo "Copied $count file(s)."
    else
        echo "Copying Classic Interface ($TYPE)..."
        echo "  Source: $src"
        echo "  Output: $OUT_DIR"
        echo ""

        local -a includes=("--include=*/")
        if [[ "$TYPE" == "textures" || "$TYPE" == "all" ]]; then
            includes+=("--include=*.png" "--include=*.blp" "--include=*.tga")
        fi
        if [[ "$TYPE" == "interface" || "$TYPE" == "all" ]]; then
            includes+=("--include=*.lua" "--include=*.xml" "--include=*.toc")
        fi

        rsync -a --info=progress2 \
            "${includes[@]}" \
            --exclude="*" \
            "$src/" "$OUT_DIR/"
    fi

    print_done
}

# ---------------------------------------------------------------------------
# Flavor routing
# ---------------------------------------------------------------------------

case "$FLAVOR" in
    retail)
        extract_retail
        ;;
    classic)
        extract_loose "_classic_"
        ;;
    classic_era)
        extract_loose "_classic_era_"
        ;;
    *)
        echo "Usage: $0 [retail|classic|classic_era]" >&2
        exit 1
        ;;
esac
