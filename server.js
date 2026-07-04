// ============================================================
// NEET INSIGHT â€” Test Analysis & Performance Management
// Node.js + Express + MongoDB + EJS + express-session
// ============================================================

const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const mongoose = require('mongoose');
const path = require('path');

// ---------- MONGODB URI CHECK ----------
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error("ERROR: MONGODB_URI environment variable is missing.");
  console.error("Set MONGODB_URI in your Render.com environment to a valid MongoDB connection string.");
  process.exit(1);
}

// ---------- APP SETUP ----------
const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.urlencoded({ extended: true, limit: '20mb' }));
app.use(bodyParser.json({ limit: '20mb' }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(
  session({
    secret: 'secret_key_neet',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
  })
);

// ============================================================
// MONGOOSE MODELS
// ============================================================

const userSchema = new mongoose.Schema({
  full_name: { type: String, default: '' },
  email: { type: String, unique: true, required: true },
  password: { type: String, default: '123456' },
  role: { type: String, enum: ['admin', 'student'], default: 'student' },
  created_at: { type: Date, default: Date.now }
});

const testSchema = new mongoose.Schema({
  test_name: { type: String, required: true },
  date: { type: Date, default: Date.now },
  type: { type: String, default: 'Mock Test' },
  duration: { type: Number, default: 180 },
  total_questions: { type: Number, default: 200 },
  source: { type: String, default: 'Manual' },
  created_at: { type: Date, default: Date.now }
});

const questionSchema = new mongoose.Schema({
  test_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Test', required: true },
  question_no: Number,
  subject: String,
  chapter: String,
  topic: String,
  difficulty: { type: String, default: 'Medium' },
  correct_answer: String,
  student_answer: String,
  status: { type: String, enum: ['Correct', 'Wrong', 'Skipped'], default: 'Skipped' },
  confidence: { type: String, default: 'Medium' },
  time_taken: { type: Number, default: 0 },
  mistake_type: { type: String, default: 'None' },
  notes: String,
  created_at: { type: Date, default: Date.now }
});

const masterChapterSchema = new mongoose.Schema({
  subject: String,
  chapter: String,
  class: String,
  weightage: Number
});

const masterTopicSchema = new mongoose.Schema({
  subject: String,
  chapter: String,
  topic: String
});

const mistakeNotebookSchema = new mongoose.Schema({
  test_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Test' },
  question_no: Number,
  date: { type: Date, default: Date.now },
  subject: String,
  chapter: String,
  topic: String,
  question: String,
  mistake_type: String,
  correct_concept: String,
  revision_status: { type: String, default: 'pending' },
  next_revision_date: Date,
  created_at: { type: Date, default: Date.now }
});

const revisionSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  question_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Question' },
  due_date: Date,
  status: { type: String, default: 'pending' },
  revision_interval: Number,
  created_at: { type: Date, default: Date.now }
});

const progressSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  metrics_json: Object,
  test_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Test' },
  updated_at: { type: Date, default: Date.now }
});

const notificationSchema = new mongoose.Schema({
  message: String,
  type: String,
  created_at: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Test = mongoose.model('Test', testSchema);
const Question = mongoose.model('Question', questionSchema);
const MasterChapter = mongoose.model('MasterChapter', masterChapterSchema);
const MasterTopic = mongoose.model('MasterTopic', masterTopicSchema);
const MistakeNotebook = mongoose.model('MistakeNotebook', mistakeNotebookSchema);
const Revision = mongoose.model('Revision', revisionSchema);
const Progress = mongoose.model('Progress', progressSchema);
const Notification = mongoose.model('Notification', notificationSchema);

// ============================================================
// MIDDLEWARE
// ============================================================

const requireAuth = (req, res, next) => {
  if (!req.session || !req.session.user) {
    return res.redirect('/login');
  }
  next();
};

// ============================================================
// REVISION ENGINE
// ============================================================
const REVISION_INTERVALS = [1, 3, 7, 15, 30, 60];

async function createRevisionEntries(questionId, userId) {
  // Dedupe: only create revision schedule if none exist for this question yet
  const existing = await Revision.findOne({ question_id: questionId });
  if (existing) return;

  const baseDate = new Date();
  const entries = REVISION_INTERVALS.map((days) => {
    const due = new Date(baseDate);
    due.setHours(0, 0, 0, 0);
    due.setDate(due.getDate() + days);
    return {
      user_id: userId,
      question_id: questionId,
      due_date: due,
      status: 'pending',
      revision_interval: days
    };
  });
  await Revision.insertMany(entries);
}

async function addToMistakeNotebook(question, testId) {
  // Dedupe: update if entry already exists for (test_id, question_no), else create
  const existing = await MistakeNotebook.findOne({
    test_id: testId,
    question_no: question.question_no
  });

  const payload = {
    test_id: testId,
    question_no: question.question_no,
    date: new Date(),
    subject: question.subject || 'Unknown',
    chapter: question.chapter || 'Unknown',
    topic: question.topic || 'Unknown',
    question: `Q${question.question_no}: ${question.notes || question.correct_answer || 'Review required'}`,
    mistake_type: question.mistake_type || 'Conceptual Gap',
    correct_concept: question.notes || `Revisit ${question.topic || question.chapter || 'this concept'}`,
    revision_status: 'pending',
    next_revision_date: new Date(Date.now() + 24 * 60 * 60 * 1000)
  };

  if (existing) {
    await MistakeNotebook.findByIdAndUpdate(existing._id, payload, { new: true });
  } else {
    await MistakeNotebook.create(payload);
  }
}

// ============================================================
// AUTH ROUTES
// ============================================================

app.get('/', (req, res) => res.redirect('/app?page=dashboard'));

app.get('/login', (req, res) => {
  res.render('login', { error: req.query.error || null });
});

app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email: (email || '').trim(), password: password || '' });
    if (!user) return res.redirect('/login?error=Invalid credentials');
    req.session.user = {
      id: user._id.toString(),
      email: user.email,
      full_name: user.full_name,
      role: user.role
    };
    res.redirect('/app?page=dashboard');
  } catch (err) {
    console.error(err);
    res.redirect('/login?error=Login failed');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ============================================================
// MAIN APP HANDLER (GET + POST /app)
// ============================================================

const appHandler = async (req, res) => {
  try {
    const user = req.session.user;
    const page = (req.query.page || (req.body && req.body.page) || 'dashboard').toString();
    const msg = req.query.msg || null;

    // ============= POST ACTIONS =============
    if (req.method === 'POST') {
      const action = req.body.action;

      // ------- Create Test -------
      if (action === 'create_test') {
        const test = await Test.create({
          test_name: req.body.test_name,
          date: req.body.date ? new Date(req.body.date) : new Date(),
          type: req.body.type || 'Mock Test',
          duration: parseInt(req.body.duration) || 180,
          total_questions: parseInt(req.body.total_questions) || 200,
          source: req.body.source || 'Manual'
        });
        return res.redirect('/app?page=test_detail&id=' + test._id + '&msg=Test created successfully');
      }

      // ------- Save Questions (Bulk) -------
      if (action === 'save_questions') {
        const testId = req.body.test_id;

        // Guard: invalid or missing test_id
        if (!testId || !mongoose.Types.ObjectId.isValid(testId)) {
          return res.redirect('/app?page=tests&msg=Invalid%20test%20selected');
        }

        let questions = [];
        try {
          questions = JSON.parse(req.body.questions_json || '[]');
        } catch (e) {
          return res.redirect('/app?page=questions&test_id=' + testId + '&msg=Invalid%20question%20data');
        }

        if (!Array.isArray(questions) || questions.length === 0) {
          return res.redirect('/app?page=questions&test_id=' + testId + '&msg=No%20questions%20to%20save');
        }

        let correct = 0,
          wrong = 0,
          skipped = 0;

        for (const q of questions) {
          if (q.question_no === undefined || q.question_no === null || q.question_no === '') continue;

          const payload = {
            test_id: testId,
            question_no: parseInt(q.question_no),
            subject: q.subject || '',
            chapter: q.chapter || '',
            topic: q.topic || '',
            difficulty: q.difficulty || 'Medium',
            correct_answer: q.correct_answer || '',
            student_answer: q.student_answer || '',
            status: q.status || 'Skipped',
            confidence: q.confidence || 'Medium',
            time_taken: parseFloat(q.time_taken) || 0,
            mistake_type: q.mistake_type || 'None',
            notes: q.notes || ''
          };

          let savedQuestion;
          if (q._id && /^[a-f0-9]{24}$/i.test(q._id)) {
            savedQuestion = await Question.findByIdAndUpdate(q._id, payload, { new: true });
          } else {
            savedQuestion = await Question.create(payload);
          }

          if (savedQuestion) {
            if (savedQuestion.status === 'Correct') correct++;
            else if (savedQuestion.status === 'Wrong') wrong++;
            else skipped++;

            // Auto mistake notebook + revision entries
            if (savedQuestion.status === 'Wrong') {
              await addToMistakeNotebook(savedQuestion, testId);
              await createRevisionEntries(savedQuestion._id, user.id);
            }
          }
        }

        const attempted = correct + wrong;
        const accuracy = attempted > 0 ? (correct / attempted) * 100 : 0;
        const negativeMarks = wrong * 1;
        const opportunityLoss = wrong * 5;
        const predictedScore = correct * 4 - wrong * 1;

        await Progress.create({
          user_id: user.id,
          test_id: testId,
          metrics_json: {
            correct,
            wrong,
            skipped,
            total: correct + wrong + skipped,
            accuracy: Math.round(accuracy * 100) / 100,
            negative_marks: negativeMarks,
            opportunity_loss: opportunityLoss,
            predicted_score: predictedScore,
            date: new Date()
          },
          updated_at: new Date()
        });

        await Notification.create({
          message: `Test updated â€” ${correct} correct, ${wrong} wrong. Score: ${predictedScore}`,
          type: 'test_saved'
        });

        return res.redirect('/app?page=test_detail&id=' + testId + '&msg=Questions saved successfully');
      }

      // ------- Update Mistake -------
      if (action === 'update_mistake') {
        const nextDate = req.body.next_revision_date
          ? new Date(req.body.next_revision_date)
          : new Date();
        await MistakeNotebook.findByIdAndUpdate(req.body.mistake_id, {
          revision_status: req.body.revision_status || 'pending',
          next_revision_date: nextDate
        });
        return res.redirect('/app?page=mistakes&msg=Mistake updated');
      }

      // ------- Mark Revision Done -------
      if (action === 'mark_revision_done') {
        await Revision.findByIdAndUpdate(req.body.revision_id, { status: 'completed' });
        return res.redirect('/app?page=revision&msg=Revision marked complete');
      }

      // ------- Delete Test -------
      if (action === 'delete_test') {
        await Question.deleteMany({ test_id: req.body.test_id });
        await MistakeNotebook.deleteMany({ test_id: req.body.test_id });
        await Test.findByIdAndDelete(req.body.test_id);
        return res.redirect('/app?page=tests&msg=Test deleted');
      }
    }

    // ============= GET DATA =============
    const data = {
      user,
      page,
      msg,
      tests: [],
      questions: [],
      progress: [],
      mistakes: [],
      due_today: [],
      upcoming: [],
      completed: [],
      analytics: {},
      current_test: null
    };

    if (page === 'dashboard') {
      data.tests = await Test.find().sort({ date: -1 });
      data.questions = await Question.find();
      data.progress = await Progress.find({ user_id: user.id }).sort({ updated_at: -1 }).limit(30);
      data.mistakes = await MistakeNotebook.find().sort({ created_at: -1 }).limit(100);
    }

    if (page === 'tests') {
      data.tests = await Test.find().sort({ date: -1 });
    }

    if (page === 'test_detail') {
      const testId = req.query.id;
      if (testId) {
        data.current_test = await Test.findById(testId);
        data.questions = await Question.find({ test_id: testId }).sort({ question_no: 1 });
      }
    }

    if (page === 'questions') {
      data.tests = await Test.find().sort({ date: -1 });
      if (req.query.test_id) data.current_test = await Test.findById(req.query.test_id);
    }

    if (page === 'analytics') {
      data.questions = await Question.find();
      data.tests = await Test.find();
      data.mistakes = await MistakeNotebook.find();
    }

    if (page === 'mistakes') {
      data.mistakes = await MistakeNotebook.find().sort({ created_at: -1 });
    }

    if (page === 'revision') {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      data.due_today = await Revision.find({
        user_id: user.id,
        status: 'pending',
        due_date: { $gte: today, $lt: tomorrow }
      })
        .populate('question_id')
        .limit(100);

      data.upcoming = await Revision.find({
        user_id: user.id,
        status: 'pending',
        due_date: { $gte: tomorrow }
      })
        .sort({ due_date: 1 })
        .populate('question_id')
        .limit(100);

      data.completed = await Revision.find({
        user_id: user.id,
        status: 'completed'
      })
        .sort({ due_date: -1 })
        .populate('question_id')
        .limit(100);
    }

    if (page === 'progress') {
      data.progress = await Progress.find({ user_id: user.id }).sort({ updated_at: 1 });
    }

    res.render('app', data);
  } catch (err) {
    console.error('App handler error:', err);
    res.status(500).send('Server error: ' + err.message);
  }
};

app.get('/app', requireAuth, appHandler);
app.post('/app', requireAuth, appHandler);

// ============================================================
// 404
// ============================================================
app.use((req, res) => {
  res.status(404).send('Not found');
});

// ============================================================
// INITIALIZE
// ============================================================
(async function init() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('MongoDB connected successfully');

    // Create default admin if not exists
    const adminExists = await User.findOne({ email: 'dipanshuydvofficial@gmail.com' });
    if (!adminExists) {
      await User.create({
        full_name: 'Administrator',
        email: 'dipanshuydvofficial@gmail.com',
        password: 'dy2009,dy2009',
        role: 'admin'
      });
      console.log('Default admin account created');
    }

    app.listen(PORT, () => {
      console.log(`NEET Insight server running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Initialization failed:', err);
    process.exit(1);
  }
})();
