function saveToDB(website, email, login, password, profileUrl, status) {
  db.run(
    `INSERT INTO registrations (website, email, login, password, profile_url, status) VALUES (?, ?, ?, ?, ?, ?)`,
    [website, email, login, password, profileUrl, status]
  );
}