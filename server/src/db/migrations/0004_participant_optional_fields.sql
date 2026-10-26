-- 0004: дополнительные поля участника из README (необязательные).
-- Номинация, возрастная категория, город, руководитель.
ALTER TABLE participants ADD COLUMN nomination TEXT;
ALTER TABLE participants ADD COLUMN category TEXT;
ALTER TABLE participants ADD COLUMN city TEXT;
ALTER TABLE participants ADD COLUMN leader TEXT;
