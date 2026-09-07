/** Shared visual control: native keyboard and pointer interaction, no inference. */
export function CoworkerEffortSlider({ index, stop, label, labelId, onChange }: {
  index: number; stop: string; label: string; labelId: string; onChange: (index: number) => void;
}) {
  return (
    <div className="effort-slider" data-stop={stop}>
    <div aria-hidden="true" className="effort-slider-track" data-testid="effort-dial-track">
      {/* The fill ends at the thumb's far edge so both rounded caps share a center. */}
      <div className="effort-slider-fill" data-testid="effort-dial-fill" style={{ width: `calc(${index * 25}% + ${32 - index * 8}px)` }}>
        <div className="effort-slider-aurora" />
        {[12, 25, 39, 51, 65, 78, 91].map((position, particle) => (
          <span key={position} className="effort-slider-particle" style={{ left: `${position}%`, top: `${32 + (particle % 3) * 18}%`, animationDelay: `${particle * -0.7}s` }} />
        ))}
        <div className="effort-slider-full-effects">
          <span className="effort-slider-sweep" />
          {[18, 46, 73].map((position, star) => (
            <svg key={position} className="effort-slider-star" viewBox="0 0 12 12" style={{ left: `${position}%`, top: `${star === 1 ? 56 : 25}%`, width: star === 1 ? 9 : 7, animationDelay: `${star * -1.6}s` }}>
              <path d="M6 0 7.5 4.5 12 6 7.5 7.5 6 12 4.5 7.5 0 6 4.5 4.5Z" />
            </svg>
          ))}
        </div>
      </div>
    </div>
    <div aria-hidden="true" className="effort-slider-stops">
      {[0, 1, 2, 3, 4].map((candidate) => <span key={candidate} />)}
    </div>
    <input
      type="range"
      min={0}
      max={4}
      step={1}
      value={index}
      aria-labelledby={labelId}
      aria-valuetext={label}
      className="effort-dial-range"
      data-testid="effort-dial-range"
      onChange={(event) => {
        onChange(Number(event.target.value));
      }}
    />
  </div>
  );
}
