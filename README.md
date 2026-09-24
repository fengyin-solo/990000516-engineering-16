# Task Board

A lightweight Trello-like task board application built with Vue 3 and Express.

## Tech Stack

### Frontend
- Vue 3 + Vite
- Vue Router
- Pinia (state management)
- Element Plus (UI components)
- vuedraggable (drag and drop)
- Axios (HTTP client)

### Backend
- Node.js + Express
- better-sqlite3 (SQLite database)
- jsonwebtoken (JWT authentication)
- bcryptjs (password hashing)
- cors

## Project Structure

```
task-board/
├── frontend/          # Vue 3 frontend (port 5174)
│   ├── src/
│   │   ├── api/       # Axios API layer
│   │   ├── components/# Reusable Vue components
│   │   ├── router/    # Vue Router configuration
│   │   ├── stores/    # Pinia stores (auth, board)
│   │   └── views/     # Page-level components
│   └── vite.config.js
├── backend/           # Express API (port 3002)
│   ├── db/            # Database init and seed scripts
│   ├── middleware/    # Auth middleware (JWT)
│   ├── routes/       # API route handlers
│   ├── data/         # SQLite database file
│   └── server.js
└── README.md
```

## Getting Started

### Prerequisites
- Node.js 18+

### Backend Setup

```bash
cd backend
npm install
npm run seed     # Seed database with demo data
npm run dev      # Start server on port 3002
```

### Frontend Setup

```bash
cd frontend
npm install
npm run dev      # Start dev server on port 5174
```

### Demo Account

- Username: `demo`
- Password: `demo123`

The seed script creates a demo user with a sample board "My Project" containing 3 columns (To Do, In Progress, Done) and 7 sample cards.

## Data-Ownership Security Check (本地安全检查环境)

后端内置一个**可重复执行**的数据归属安全检查，覆盖：未登录、无/无效令牌、过期令牌、
跨账号读取、移动卡片到他人列、删除他人看板，并回归正常用户操作与既有错误状态码。

```bash
cd backend
npm install            # 首次或依赖缺失时（脚本会在「阶段 1」明确指出缺什么）
npm run security-check
```

- **隔离运行**：每次在系统临时目录创建全新 SQLite 数据库（`DB_PATH` 环境变量隔离），
  并在随机端口启动真实 HTTP 服务，绝不触碰 `backend/data/taskboard.db`。
- **无残留**：结束（含失败、Ctrl-C）自动关闭服务并删除临时目录，可反复执行。
- **分阶段报告**：依赖缺失或检查失败会指出具体阶段与检查点编号（如 `S3.1`），
  退出码非 0 便于接入 CI/提交前钩子。
- 调试时可用 `node security-check/check.js --keep-db` 保留临时数据库现场。

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login (returns JWT)

### Boards
- `GET /api/boards` - List user's boards
- `POST /api/boards` - Create board
- `DELETE /api/boards/:id` - Delete board

### Columns
- `GET /api/boards/:boardId/columns` - Get columns for a board
- `POST /api/boards/:boardId/columns` - Add column
- `PUT /api/columns/:id` - Update column (rename/reorder)
- `DELETE /api/columns/:id` - Delete column

### Cards
- `GET /api/columns/:columnId/cards` - Get cards in column
- `POST /api/columns/:columnId/cards` - Add card
- `PUT /api/cards/:id` - Update card
- `DELETE /api/cards/:id` - Delete card
- `PUT /api/cards/:id/move` - Move card to another column

## Features

- User authentication with JWT
- Create and manage multiple boards
- Add, rename, and delete columns
- Create cards with title, description, priority (low/medium/high), and due date
- Drag and drop cards between columns
- Drag and drop to reorder columns
- Responsive design with Element Plus UI
