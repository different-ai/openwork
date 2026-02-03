declare const Bun: {
  serve: (options: {
    hostname: string;
    port: number;
    fetch: (request: Request) => Response | Promise<Response>;
  }) => {
    port: number;
  };
};
