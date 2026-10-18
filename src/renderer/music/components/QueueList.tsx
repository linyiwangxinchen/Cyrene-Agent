import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Trash2, X } from "lucide-react";
import type { Track } from "../types";
import { formatTime } from "../types";

interface QueueListProps {
  queue: Track[];
  currentId?: string;
  onPlay(track: Track): void;
  /** 从队列移除（普通歌单的 X 按钮） */
  onRemove?(index: number): void;
  /** 删除缓存文件（仅缓存歌单的 Trash2 按钮，后端拒删正在播放的曲） */
  onDeleteTrack?(track: Track): void;
}

export default function QueueList(props: QueueListProps) {
  if (props.queue.length === 0) return <div className="panel-empty">队列为空</div>;
  return <VirtualQueueList {...props} />;
}

function VirtualQueueList({
  queue,
  currentId,
  onPlay,
  onRemove,
  onDeleteTrack,
}: QueueListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: queue.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 48,
    overscan: 6,
    getItemKey: (index) => `${queue[index].encryptedId}-${index}`,
  });
  return (
    <div ref={scrollRef} className="queue" style={{ minHeight: 0 }}>
      <ul style={{ height: virtualizer.getTotalSize(), position: "relative", margin: 0, padding: 0, listStyle: "none" }}>
        {virtualizer.getVirtualItems().map((row) => {
          const i = row.index;
          const track = queue[i];
          const active = track.encryptedId === currentId;
          const disabled = !track.visible;
          return (
            <li
              key={row.key}
              ref={virtualizer.measureElement}
              data-index={i}
              aria-posinset={i + 1}
              aria-setsize={queue.length}
              style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${row.start}px)` }}
              className={[
                "queue-item",
                active ? "is-active" : "",
                disabled ? "is-disabled" : "",
              ].join(" ")}
              onDoubleClick={() => !disabled && onPlay(track)}
            >
              <span className="queue-indicator">
                {active && (
                  <span className="eq">
                    <i />
                    <i />
                    <i />
                  </span>
                )}
              </span>
              <button
                type="button"
                className="queue-main"
                disabled={disabled}
                onClick={() => onPlay(track)}
                title={disabled ? "该歌曲暂时无法播放" : track.name}
              >
                <span className="queue-name">{track.name}</span>
                <span className="queue-artist">
                  {track.artists.join(" / ")}
                </span>
              </button>
              {disabled && <span className="queue-tag">无法播放</span>}
              <span className="queue-duration">
                {formatTime(track.durationMs ?? 0)}
              </span>
              {onDeleteTrack ? (
                <button
                  type="button"
                  className="icon-btn queue-remove queue-delete"
                  title="删除缓存"
                  onClick={() => onDeleteTrack(track)}
                >
                  <Trash2 size={14} />
                </button>
              ) : onRemove ? (
                <button
                  type="button"
                  className="icon-btn queue-remove"
                  title="从队列移除"
                  onClick={() => onRemove(i)}
                >
                  <X size={14} />
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
