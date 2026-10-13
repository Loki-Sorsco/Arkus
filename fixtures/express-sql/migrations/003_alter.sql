ALTER TABLE orders ADD COLUMN email VARCHAR(255);
ALTER TABLE users DROP COLUMN created_at;
CREATE TABLE temp_stuff (id INT);
DROP TABLE temp_stuff;
