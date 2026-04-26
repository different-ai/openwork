"use client";

import { useEffect, useRef } from "react";
import type { PillTexture } from "@/types";
import { ScrollTrigger } from "gsap/all";
import Matter, { Bodies, Composite, Mouse, MouseConstraint } from "matter-js";

interface PillImagePhysicsSimulationProps {
  pills: PillTexture[];
  scale?: number;
  restitution?: number;
}

const PillImagePhysicsSimulation = ({ pills, scale = 0.4, restitution = 0.4 }: PillImagePhysicsSimulationProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!containerRef.current || pills.length === 0) return;

    const width = containerRef.current.clientWidth;
    const height = containerRef.current.clientHeight;

    const engine = Matter.Engine.create();

    const render = Matter.Render.create({
      element: containerRef.current,
      engine,
      options: {
        width,
        height,
        background: "transparent",
        wireframes: false,
      },
    });

    Matter.Render.run(render);
    const runner = Matter.Runner.create();
    Matter.Runner.run(runner, engine);

    const world = engine.world;

    // === Create ONE body per pill ===
    const bodies = pills.map(pill => {
      const bodyWidth = pill.width * scale;
      const bodyHeight = pill.height * scale;
      const radius = bodyHeight / 2;

      const x = Matter.Common.random(bodyWidth, width - bodyWidth);
      const y = Matter.Common.random(-height, -50);

      return Bodies.rectangle(x, y, bodyWidth, bodyHeight, {
        chamfer: { radius },
        restitution,
        frictionAir: 0.02,
        render: {
          fillStyle: "transparent",
          strokeStyle: "transparent",
          sprite: {
            texture: pill.texture,
            xScale: scale,
            yScale: scale,
          },
        },
      });
    });

    world.gravity.y = 0;

    ScrollTrigger.create({
      trigger: containerRef.current,
      start: "top 80%",
      once: true,
      onEnter: () => {
        world.gravity.y = 1; // default gravity
      },
    });

    Composite.add(world, bodies);

    // === Invisible walls ===
    Composite.add(world, [
      Bodies.rectangle(width / 2, height + 40, width, 80, {
        isStatic: true,
        render: { fillStyle: "transparent" },
      }),
      Bodies.rectangle(-40, height / 2, 80, height, {
        isStatic: true,
        render: { fillStyle: "transparent" },
      }),
      Bodies.rectangle(width + 40, height / 2, 80, height, {
        isStatic: true,
        render: { fillStyle: "transparent" },
      }),
    ]);

    // === Mouse interaction ===
    const mouse = Mouse.create(render.canvas);
    const mouseConstraint = MouseConstraint.create(engine, {
      mouse,
      constraint: {
        stiffness: 0.15,
        render: { visible: false },
      },
    });

    Composite.add(world, mouseConstraint);
    render.mouse = mouse;

    // === Cleanup ===
    return () => {
      Matter.Render.stop(render);
      Matter.Runner.stop(runner);
      Matter.World.clear(world, false);
      Matter.Engine.clear(engine);
      render.canvas.remove();
      render.textures = {};
    };
  }, [pills, scale, restitution]);

  return <div ref={containerRef} className="absolute inset-0 overflow-hidden" />;
};

export default PillImagePhysicsSimulation;
