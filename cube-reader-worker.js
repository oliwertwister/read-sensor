self.window = self;
importScripts("vendor/zarrita-read-sensor.min.js?v=0.7.5");

const cubes = new Map();

async function cubeFor(url) {
  if (!cubes.has(url)) {
    cubes.set(url, self.ReadSensorZarr.openCube(url));
  }
  return cubes.get(url);
}

async function handle(message) {
  const cube = await cubeFor(message.cubeUrl);
  if (message.op === "window2d") {
    const result = await cube.window2d(
      message.variable,
      message.prefix || [],
      message.yStart,
      message.yStop,
      message.xStart,
      message.xStop,
    );
    const copy = new Float32Array(result.data.length);
    copy.set(result.data);
    return {
      id: message.id,
      ok: true,
      shape: result.shape,
      data: copy.buffer,
      transfer: [copy.buffer],
    };
  }

  if (message.op === "grid") {
    const latitude = await cube.openArray("latitude");
    const longitude = await cube.openArray("longitude");
    const latFirst = Number(await cube.scalar("latitude", [0]));
    const latLast = Number(await cube.scalar("latitude", [latitude.shape[0] - 1]));
    const lonFirst = Number(await cube.scalar("longitude", [0]));
    const lonLast = Number(await cube.scalar("longitude", [longitude.shape[0] - 1]));
    return {
      id: message.id,
      ok: true,
      latitude: { count: latitude.shape[0], first: latFirst, last: latLast },
      longitude: { count: longitude.shape[0], first: lonFirst, last: lonLast },
    };
  }

  throw new Error(`Unsupported cube worker operation: ${message.op}`);
}

self.onmessage = async (event) => {
  try {
    const response = await handle(event.data || {});
    self.postMessage(response, response.transfer || []);
  } catch (error) {
    self.postMessage({
      id: event.data?.id,
      ok: false,
      error: String(error),
      cause: error?.cause ? String(error.cause) : null,
    });
  }
};
