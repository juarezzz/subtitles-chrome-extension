import { Subtitle } from "../context/subtitles";
import { SubtitleSettings } from "../context/settings";
import { isValidTimeOffset } from "../utils/isValidTimeOffset";

interface VideoTarget {
  frameId: number;
  documentId: string;
  videoIndex: number;
  videoId?: string;
}

interface SubtitleMessage {
  type:
    | "ADD_SUBTITLES"
    | "UPDATE_SUBTITLES"
    | "TOGGLE_SUBTITLES"
    | "DESTROY_SUBTITLES"
    | "UPDATE_SUBTITLE_SETTINGS";
  target?: VideoTarget;
  subtitles?: Subtitle[];
  visible?: boolean;
  settings?: SubtitleSettings;
}

class SubtitlesManager {
  private subtitles: Subtitle[] = [];
  private video: HTMLVideoElement | null = null;
  private subtitleElement: HTMLDivElement | null = null;
  private shadowHost: HTMLDivElement | null = null;
  private shadowRoot: ShadowRoot | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private scrollHandler: (() => void) | null = null;
  private fullscreenHandler: (() => void) | null = null;
  private isFullscreen: boolean = false;
  private settings: SubtitleSettings | null = null;

  async init(target: VideoTarget, subtitles: Subtitle[]) {
    this.subtitles = subtitles;

    // Load settings from storage
    await this.loadSettings();

    this.video = this.findTargetVideo(target);

    if (!this.video) {
      console.error("Target video not found", target);
      return false;
    }

    this.addSubtitleElement();
    this.attachEventListeners();
    return true;
  }

  private async loadSettings() {
    try {
      const result = await chrome.storage.local.get("subtitleSettings");
      if (result.subtitleSettings) {
        this.settings = result.subtitleSettings;
      } else {
        // Default settings if none are saved
        this.settings = {
          syncOffset: 0,
          fontSize: 20,
          fontColor: "#ffffff",
          background: false,
          backgroundColor: "#000000",
          fontFamily: "Arial, sans-serif",
          offsetFromBottom: 60,
          textShadow: true,
          shadowColor: "#000000",
          verticalPadding: 8,
          horizontalPadding: 8,
        };
      }
    } catch (error) {
      console.error("Error loading subtitle settings:", error);
    }
  }

  updateSettings(settings: SubtitleSettings) {
    this.settings = settings;
    if (this.subtitleElement) {
      this.applyStyles();
      this.updateSubtitlePosition();
      this.updateSubtitleContent();
    }
  }

  private addSubtitleElement() {
    if (!this.video || !this.settings) return false;

    // Remove existing subtitle element if it exists
    this.removeSubtitleElement();

    // Create shadow host element
    this.shadowHost = document.createElement("div");
    this.shadowHost.id = "subtitle-shadow-host";

    // Style the shadow host - it will be positioned where subtitles should appear
    this.shadowHost.style.cssText = `
      position: absolute;
      z-index: 2147483647;
      transform: translateX(-50%) translateY(-100%);
    `;

    // Create shadow root with closed mode for better isolation
    this.shadowRoot = this.shadowHost.attachShadow({ mode: "open" });

    // Create the actual subtitle element
    this.subtitleElement = document.createElement("div");
    this.subtitleElement.id = "subtitle-element";

    this.applyStyles();
    this.updateSubtitlePosition();
    this.updateSubtitleContent();

    // Append subtitle element to shadow root
    this.shadowRoot.appendChild(this.subtitleElement);

    // Append shadow host to appropriate container based on fullscreen state
    this.appendSubtitleElement();
    return true;
  }

  private applyStyles() {
    if (!this.subtitleElement || !this.settings) return;

    const textShadow = this.settings.textShadow
      ? `2px 2px 4px ${this.settings.shadowColor}`
      : "none";

    const backgroundColor = this.settings.background
      ? this.settings.backgroundColor
      : "transparent";

    this.subtitleElement.style.cssText = `
      color: ${this.settings.fontColor};
      font-size: ${this.settings.fontSize}px;
      font-family: ${this.settings.fontFamily};
      padding: ${this.settings.verticalPadding}px ${this.settings.horizontalPadding}px;
      background-color: ${backgroundColor};
      text-shadow: ${textShadow};
      text-align: center;
      white-space: pre-line;
      font-weight: bold;
      line-height: 1.4;
      word-wrap: break-word;
      max-width: 90vw;
    `;
  }

  private appendSubtitleElement() {
    if (!this.shadowHost) return;

    // Check if we're in fullscreen mode
    this.isFullscreen = !!document.fullscreenElement;

    if (this.isFullscreen) {
      // In fullscreen, append to the fullscreen element or its container
      const fullscreenElement = document.fullscreenElement;
      if (fullscreenElement) fullscreenElement.appendChild(this.shadowHost);
      else document.body.appendChild(this.shadowHost);
    }
    // Normal mode - append to document body
    else document.body.appendChild(this.shadowHost);
  }

  private removeSubtitleElement() {
    if (this.shadowHost) {
      this.shadowHost.remove();
      this.shadowHost = null;
    }

    if (this.shadowRoot) this.shadowRoot = null;

    if (this.subtitleElement) this.subtitleElement = null;
  }

  private attachEventListeners() {
    if (!this.video) return false;

    this.video.addEventListener(
      "timeupdate",
      this.updateSubtitleContent.bind(this)
    );

    // Use ResizeObserver to watch for video size changes
    this.resizeObserver = new ResizeObserver(() => {
      this.updateSubtitlePosition();
    });
    this.resizeObserver.observe(this.video);

    window.addEventListener("resize", this.updateSubtitlePosition.bind(this), {
      passive: true,
    });

    // Listen for scroll events to update position
    this.scrollHandler = () => {
      this.updateSubtitlePosition();
    };

    // Listen for scroll on both window and document
    window.addEventListener("scroll", this.scrollHandler, { passive: true });
    document.addEventListener("scroll", this.scrollHandler, { passive: true });

    // Listen for fullscreen changes
    this.fullscreenHandler = () => {
      this.handleFullscreenChange();
    };

    // Add fullscreen event listeners for different browsers
    document.addEventListener("fullscreenchange", this.fullscreenHandler);
    document.addEventListener("webkitfullscreenchange", this.fullscreenHandler);
    document.addEventListener("mozfullscreenchange", this.fullscreenHandler);
    document.addEventListener("MSFullscreenChange", this.fullscreenHandler);

    return true;
  }

  private handleFullscreenChange() {
    const wasFullscreen = this.isFullscreen;

    this.isFullscreen = !!document.fullscreenElement;

    // If fullscreen state changed, re-append the shadow host element
    if (wasFullscreen !== this.isFullscreen) {
      if (this.shadowHost) {
        // Remove from current parent
        this.shadowHost.remove();

        // Re-append to appropriate container
        this.appendSubtitleElement();

        // Update positioning and styling for new context
        this.updateSubtitlePosition();
      }
    }
  }

  private updateSubtitlePosition() {
    if (!this.shadowHost || !this.video || !this.settings) return false;

    try {
      const videoRect = this.video.getBoundingClientRect();

      const subtitleTop =
        videoRect.bottom - this.settings.offsetFromBottom + window.scrollY;
      const subtitleLeft = videoRect.left + videoRect.width / 2;

      this.shadowHost.style.top = `${subtitleTop}px`;
      this.shadowHost.style.left = `${subtitleLeft}px`;

      return true;
    } catch (error) {
      console.error("Error updating subtitle position:", error);
      return false;
    }
  }

  private updateSubtitleContent() {
    if (!this.subtitleElement || !this.video) return false;

    try {
      const currentTime = this.video.currentTime;

      const timeOffset = isValidTimeOffset(this.settings?.syncOffset)
        ? this.settings.syncOffset
        : 0;

      const adjustedTime = currentTime + timeOffset;

      const currentSubtitle = this.subtitles.find(
        (sub) => sub.start <= adjustedTime && sub.end >= adjustedTime
      );

      if (!currentSubtitle) {
        this.subtitleElement.textContent = null;
        this.subtitleElement.style.display = "none";
        return false;
      }

      this.subtitleElement.style.display = "block";
      this.subtitleElement.textContent = currentSubtitle.text;
      return true;
    } catch (error) {
      console.error("Error updating subtitle content:", error);
      return false;
    }
  }

  private findTargetVideo(target: VideoTarget): HTMLVideoElement | null {
    const videos = Array.from(document.querySelectorAll("video"));

    if (target.videoId) {
      return videos.find((v) => v.id === target.videoId) || null;
    }

    if (target.videoIndex !== undefined) {
      return videos[target.videoIndex] || null;
    }

    // Return first video if no specific target
    return videos[0] || null;
  }
}

const subtitleManager = new SubtitlesManager();

// Message listener
chrome.runtime.onMessage.addListener(
  (message: SubtitleMessage, _, sendResponse) => {
    try {
      switch (message.type) {
        case "ADD_SUBTITLES":
          if (message.target && message.subtitles) {
            subtitleManager
              .init(message.target, message.subtitles)
              .then((success) => {
                sendResponse({ success });
              })
              .catch((error) => {
                sendResponse({ success: false, error: error.message });
              });
          } else {
            sendResponse({
              success: false,
              error: "Missing target or subtitles data",
            });
          }
          break;

        case "UPDATE_SUBTITLE_SETTINGS":
          if (message.settings) {
            subtitleManager.updateSettings(message.settings);
            sendResponse({ success: true });
          } else {
            sendResponse({ success: false, error: "Missing settings data" });
          }
          break;

        default:
          sendResponse({ success: false, error: "Unknown message type" });
      }
    } catch (error) {
      console.error("Error handling subtitle message:", error);
      sendResponse({ success: false, error: (error as Error).message });
    }
  }
);
