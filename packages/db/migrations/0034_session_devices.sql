-- Signed-in devices (card R4): the kind of device each session was signed in from, shown in Settings.
-- Only a short label made from the browser's user agent is kept ("Mac", "iPhone", "Windows PC" and so on), never
-- the user agent itself. Sessions made before this change, or from a device that cannot be told, have none.
alter table sessions add column device text check (char_length(device) <= 60);
