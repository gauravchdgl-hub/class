const bcrypt = require('bcryptjs');
const db = require('./index');

function seed() {
  const adminExists = db.prepare('SELECT id FROM users WHERE email = ?').get('admin@ausacademy.com');
  if (!adminExists) {
    db.prepare('INSERT INTO users (name, email, password, role, email_verified) VALUES (?,?,?,?,1)')
      .run('Admin', 'admin@ausacademy.com', bcrypt.hashSync('admin123', 8), 'admin');
    console.log('Admin created: admin@ausacademy.com / admin123');
  }

  const subjectCount = db.prepare('SELECT COUNT(*) c FROM subjects').get().c;
  if (subjectCount === 0) {
    const insSub = db.prepare('INSERT INTO subjects (name, year) VALUES (?,?)');
    const subjects = [
      ['Economics', 'Year 11'], ['Economics', 'Year 12'],
      ['Maths', 'Year 11'], ['Maths', 'Year 12'],
      ['Chemistry', 'Year 11'], ['Chemistry', 'Year 12'],
      ['Physics', 'Year 11'], ['Physics', 'Year 12'],
    ];
    subjects.forEach((s) => insSub.run(...s));
    console.log('Subjects seeded');
  }

  const planCount = db.prepare('SELECT COUNT(*) c FROM mcq_plans').get().c;
  if (planCount === 0) {
    const insPlan = db.prepare('INSERT INTO mcq_plans (name, mcq_count, price, validity_days) VALUES (?,?,?,?)');
    insPlan.run('Free Plan', 50, 0, 36500);
    insPlan.run('Basic Plan', 100, 50, 30);
    insPlan.run('Standard Plan', 200, 100, 60);
    insPlan.run('Premium Plan', 500, 200, 90);
    console.log('MCQ plans seeded (Free Plan auto-granted to every new student)');
  }

  const settingsCount = db.prepare('SELECT COUNT(*) c FROM site_settings').get().c;
  if (settingsCount === 0) {
    db.prepare('INSERT INTO site_settings (key, value) VALUES (?,?)').run('logo_url', '');
    console.log('Site settings seeded');
  }

  const paperCount = db.prepare('SELECT COUNT(*) c FROM exam_papers').get().c;
  if (paperCount === 0) {
    const econ12 = db.prepare('SELECT id FROM subjects WHERE name = ? AND year = ?').get('Economics', 'Year 12');
    const paperId = db.prepare(
      'INSERT INTO exam_papers (title, year, subject_id, price, duration_minutes) VALUES (?,?,?,?,?)'
    ).run('Year 12 Economics Practice Paper 1', 'Year 12', econ12.id, 12.0, 120).lastInsertRowid;

    const insQ = db.prepare(
      `INSERT INTO exam_paper_questions
       (paper_id, type, question, option_a, option_b, option_c, option_d, correct_option, marks, word_limit, order_no)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    );
    let order = 1;
    for (let i = 1; i <= 20; i++) {
      insQ.run(
        paperId, 'mcq', `Which of the following best describes opportunity cost? (Q${i})`,
        'The total cost of production', 'The next best alternative forgone',
        'The fixed cost of a business', 'The market equilibrium',
        'B', 1, null, order++
      );
    }
    for (let i = 1; i <= 4; i++) {
      insQ.run(
        paperId, 'written', `Explain the concept of supply and demand and how it determines market equilibrium. (Q${i})`,
        null, null, null, null, null, 5, 500, order++
      );
    }
    insQ.run(
      paperId, 'essay', 'Discuss the impact of globalisation on the Australian economy.',
      null, null, null, null, null, 10, 1000, order++
    );
    console.log('Sample exam paper seeded (20 MCQ + 4 written + 1 essay)');

    const mcqPlanTopics = db.prepare('SELECT id, year FROM subjects WHERE name = ?').all('Economics');
    const insMcq = db.prepare(
      `INSERT INTO mcqs (subject_id, year, topic, question, option_a, option_b, option_c, option_d, correct_option)
       VALUES (?,?,?,?,?,?,?,?,?)`
    );
    mcqPlanTopics.forEach((s) => {
      for (let i = 1; i <= 10; i++) {
        insMcq.run(
          s.id, s.year, 'General',
          `Sample practice MCQ #${i} for ${s.year}`,
          'Option A', 'Option B', 'Option C', 'Option D', 'A'
        );
      }
    });
    console.log('Sample MCQ bank seeded');
  }
}

seed();
module.exports = seed;
