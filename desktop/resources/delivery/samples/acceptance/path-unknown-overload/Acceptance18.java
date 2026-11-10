package acceptance;
import java.sql.Statement;
import java.nio.file.Files;
import java.nio.file.Path;
import java.io.FileInputStream;
class Acceptance18 {
UnknownSelector selector; @GetMapping("/ambiguous") byte[] entry(String name) throws Exception { return load(selector.select(name)); } byte[] load(String value) throws Exception { return Files.readAllBytes(Path.of(value)); } byte[] load(Path value) throws Exception { return Files.readAllBytes(value); }
}
