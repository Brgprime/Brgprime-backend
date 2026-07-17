// Holds the Socket.IO server instance so controllers can broadcast events
// (e.g. the REST forum endpoint can push a message to connected clients).
let ioInstance = null;

export const setIo = (io) => {
  ioInstance = io;
};

export const getIo = () => ioInstance;
