package acceptance;
import java.sql.Statement;
import java.nio.file.Files;
import java.nio.file.Path;
import java.io.FileInputStream;
class Acceptance07 {
@GetMapping("/status") void status(String ignored) throws Exception { new ProcessBuilder("/usr/bin/id","-u").start(); }
}
