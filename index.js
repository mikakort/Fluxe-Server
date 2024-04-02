const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const dotenv = require('dotenv').config();
const cors = require('cors');

const app = express();

app.use(express.json());
app.use(cors());

const port = process.env.PORT;

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

mongoose.connect(process.env.DB);

const db = mongoose.connection;

db.on('error', console.error.bind(console, 'connection error:'));
db.once('open', function () {
  console.log('Successfully connected to the database');
});

const userSchema = new mongoose.Schema({
  id: String,
  socketId: String,
});

const User = mongoose.model('User', userSchema);

const roomSchema = new mongoose.Schema({
  id: String,
  users: [userSchema],
  chatLog: [{ message: String, timestamp: Date }],
  status: String,
});

const Room = mongoose.model('Room', roomSchema);

let usersQueue = [];

let recentDisc = [];

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  const user = new User({ id: uuidv4(), socketId: socket.id });
  // implement start here
  usersQueue.push(user);

  const roomInit = () => {
    if (usersQueue.length >= 2) {
      const room = new Room({
        id: uuidv4(),
        users: [usersQueue.shift(), usersQueue.shift()],
        chatLog: [],
        status: 'open',
      });
      room.save().then(() => {
        io.to(room.users[0].socketId).emit('user:joined', {
          room: room.id,
          remote: room.users[1].socketId,
          peerServer: 'A', // fixing double call problem
        });
        io.to(room.users[1].socketId).emit('user:joined', {
          room: room.id,
          remote: room.users[0].socketId,
          peerServer: 'B', // fixing double call problem
        });
      });
      console.log(room.id);
      console.log(room.users[0].socketId + ' A');
      console.log(room.users[1].socketId + ' B');
    }
  };
  roomInit();

  socket.on('messagetoserver', async (roomId, message, to) => {
    console.log(message);

    const room = await Room.findOne({ id: roomId });
    if (!room) {
      console.log('room not found');
      return;
    }

    io.to(to).emit('message', { text: message });

    room.chatLog.push({ message: message, timestamp: new Date() });
    await room.save();
  });

  socket.on('user:call', async ({ roomId, offer }) => {
    const room = await Room.findOne({ id: roomId });
    if (room.users[0].socketId) {
      const to = room.users[1].socketId;
      console.log('calling ' + to);
      io.to(to).emit('incomming:call', { from: socket.id, offer });
    }
  });

  socket.on('call:accepted', ({ to, ans }) => {
    io.to(to).emit('call:accepted', { ans: ans });
  });

  socket.on('peer:nego:needed', ({ to, offer }) => {
    console.log('peer:nego:needed', offer);
    io.to(to).emit('peer:nego:needed', { from: socket.id, offer });
  });

  socket.on('peer:nego:done', ({ to, ans }) => {
    console.log('peer:nego:done', ans);
    io.to(to).emit('peer:nego:final', { from: socket.id, ans });
  });

  socket.on('user:disconnect', async () => {
    console.log('user:disconnect ', socket.id);

    // Find the room the user was in
    const room = await Room.findOne({ 'users.socketId': socket.id });
    if (!room) {
      console.log('no room');
      return;
    }

    const arg = (id) => id.socketId !== socket.id;
    const peerIndex = room.users.findIndex(arg);
    console.log(peerIndex);
    let guest = room.users[peerIndex].socketId;

    if (guest !== undefined && room.status === 'open') {
      room.status = 'closed';
      await room.save();
      recentDisc = [...recentDisc, guest, socket.id];
      io.to(guest).emit('peer:skip', { who: 'Peer' });
      io.to(socket.id).emit('peer:skip', { who: 'You' });
    } else {
      console.log("couldn't find other user");
    }
  });

  socket.on('disconnect', async () => {
    console.log('User got disconnected:', socket.id);

    // Find the room the user was in
    const room = await Room.findOne({ 'users.socketId': socket.id });

    // Check if mid-queue disconnection
    if (!room) {
      console.log('No room, removing from queue');
      // Logic for disconnect while in queue
      const arg = (id) => id.socketId == socket.id;
      const i = usersQueue.findIndex(arg);
      if (i > -1) {
        usersQueue.splice(i, 1);
      }

      return;
    }

    const arg = (id) => id.socketId !== socket.id;

    const peerIndex = room.users.findIndex(arg);
    console.log(peerIndex);
    let guest = room.users[peerIndex].socketId;

    const argA = (id) => id !== socket.id;

    const argB = (id) => id !== guest;

    if (guest !== undefined && room.status === 'open' && !recentDisc.findIndex(argA) && !recentDisc.findIndex(argB)) {
      room.status = 'closed';
      await room.save();
      console.log(room);
      io.to(room.users[peerIndex].socketId).emit('peer:skip', { who: 'Peer' });
    } else {
      console.log("couldn't find other user");
    }
  });
});

server.listen(port, () => console.log('Server started listenning to fluxe'));
