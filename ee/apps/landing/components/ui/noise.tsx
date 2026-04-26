const Noise = () => {
  return (
    <div
      className="bg-background pointer-events-none fixed inset-0 -z-10 h-full w-full bg-[url(/noise.png)]"
      style={{ opacity: "var(--noise-opacity, 0.35)" }}
    />
  );
};

export default Noise;
