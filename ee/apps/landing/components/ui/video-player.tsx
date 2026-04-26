"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Maximize, Minimize, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { cn } from "@/lib/utils";

type VideoPlayerProps = {
  src: string;
  className?: string;
};

const formatTime = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
};

const VideoPlayer = ({ src, className }: VideoPlayerProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout>>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [volume, setVolume] = useState(1);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showControls, setShowControls] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);

  const resetHideTimer = useCallback(() => {
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    setShowControls(true);
    if (isPlaying) {
      hideTimeoutRef.current = setTimeout(() => setShowControls(false), 2500);
    }
  }, [isPlaying]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play();
      setHasStarted(true);
    } else {
      video.pause();
    }
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setIsMuted(video.muted);
  }, []);

  const handleVolumeChange = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (!video) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    video.volume = ratio;
    setVolume(ratio);
    if (ratio === 0) {
      video.muted = true;
      setIsMuted(true);
    } else if (video.muted) {
      video.muted = false;
      setIsMuted(false);
    }
  }, []);

  const toggleFullscreen = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      container.requestFullscreen();
    }
  }, []);

  const handleProgressClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    const bar = progressRef.current;
    if (!video || !bar) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    video.currentTime = ratio * video.duration;
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onPlay = () => setIsPlaying(true);
    const onPause = () => {
      setIsPlaying(false);
      setShowControls(true);
    };
    const onTimeUpdate = () => {
      setCurrentTime(video.currentTime);
      setProgress(video.duration ? (video.currentTime / video.duration) * 100 : 0);
    };
    const onLoadedMetadata = () => setDuration(video.duration);
    const onFullscreenChange = () => setIsFullscreen(!!document.fullscreenElement);

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("loadedmetadata", onLoadedMetadata);
    document.addEventListener("fullscreenchange", onFullscreenChange);

    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
    };
  }, []);

  useEffect(() => {
    if (isPlaying) {
      resetHideTimer();
    } else {
      setShowControls(true);
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    }
  }, [isPlaying, resetHideTimer]);

  return (
    <div
      ref={containerRef}
      className={cn("group relative h-full w-full cursor-pointer", className)}
      onMouseMove={resetHideTimer}
      onMouseLeave={() => isPlaying && setShowControls(false)}
    >
      <video
        ref={videoRef}
        className="h-full w-full object-cover"
        preload="metadata"
        playsInline
        muted
        onClick={togglePlay}
      >
        <source src={src} type="video/mp4" />
      </video>

      {/* Large center play button — only before first play */}
      {!hasStarted && (
        <button
          type="button"
          onClick={togglePlay}
          className="ease-primary absolute inset-0 z-10 grid place-content-center transition-opacity duration-500"
        >
          <div className="bg-background/90 text-foreground grid size-[9.6rem] place-content-center rounded-full shadow-lg backdrop-blur-sm">
            <Play className="ml-[0.4rem] size-[3.6rem]" fill="currentColor" strokeWidth={0} />
          </div>
        </button>
      )}

      {/* Bottom controls */}
      <div
        className={cn(
          "ease-primary absolute inset-x-0 bottom-0 z-20 flex flex-col gap-[0.8rem] bg-gradient-to-t from-black/60 to-transparent px-[1.6rem] pt-[4rem] pb-[1.6rem] transition-opacity duration-500",
          showControls || !isPlaying ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        {/* Progress bar */}
        <div
          ref={progressRef}
          className="group/progress relative h-[0.4rem] w-full cursor-pointer rounded-full bg-white/20 transition-[height] duration-200 hover:h-[0.6rem]"
          onClick={handleProgressClick}
        >
          <div
            className="bg-background absolute inset-y-0 left-0 rounded-full"
            style={{ width: `${progress}%` }}
          />
        </div>

        {/* Controls row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-[1.2rem]">
            <button
              type="button"
              onClick={togglePlay}
              className="text-white transition-opacity duration-200 hover:opacity-80"
            >
              {isPlaying ? (
                <Pause className="size-[2rem]" fill="currentColor" strokeWidth={0} />
              ) : (
                <Play className="ml-[0.2rem] size-[2rem]" fill="currentColor" strokeWidth={0} />
              )}
            </button>
            <div className="group/vol flex items-center gap-[0.8rem]">
              <button
                type="button"
                onClick={toggleMute}
                className="text-white transition-opacity duration-200 hover:opacity-80"
              >
                {isMuted ? (
                  <VolumeX className="size-[2rem]" />
                ) : (
                  <Volume2 className="size-[2rem]" />
                )}
              </button>
              <div
                className="ease-primary relative h-[0.4rem] w-0 cursor-pointer overflow-hidden rounded-full bg-white/20 transition-all duration-300 group-hover/vol:w-[8rem]"
                onClick={handleVolumeChange}
              >
                <div
                  className="bg-background absolute inset-y-0 left-0 rounded-full"
                  style={{ width: `${isMuted ? 0 : volume * 100}%` }}
                />
              </div>
            </div>
            <span className="font-sans text-[1.2rem] font-medium text-white/60">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>
          <button
            type="button"
            onClick={toggleFullscreen}
            className="text-white transition-opacity duration-200 hover:opacity-80"
          >
            {isFullscreen ? (
              <Minimize className="size-[2rem]" />
            ) : (
              <Maximize className="size-[2rem]" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default VideoPlayer;
