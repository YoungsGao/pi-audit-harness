package acceptance;
import java.sql.Statement;
import java.nio.file.Files;
import java.nio.file.Path;
import java.io.FileInputStream;
class Acceptance06 {
@PostMapping("/archive") void archive(String name) throws Exception { new ProcessBuilder("sh","-c","tar -cf /tmp/result.tar "+name).start(); }
}
